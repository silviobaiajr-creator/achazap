/**
 * Skill: catalog-ledger
 * Responsabilidade: Todas as operações de leitura e escrita no catálogo de produtos.
 * Inclui busca de similares (pg_trgm + Gemini semântico), inserção (UPSERT),
 * atualização de preço e soft-delete via ledger append-only.
 */

import { supabaseAdmin as supabase } from '../../lib/supabase.js';
import { ai, GEMINI_MODEL } from '../../lib/gemini.js';
import { logger, logTokens } from '../../lib/logger.js';
import { IndicesSimilaresSchema, parseSafe } from '../schemas.js';
import { DadosProduto } from '../types.js';

// ============================================================
// HELPER: Geração de Embeddings
// ============================================================
export async function gerarEmbedding(texto: string): Promise<number[] | null> {
    try {
        const result = await ai.models.embedContent({
            model: 'gemini-embedding-001',
            contents: texto,
            config: { outputDimensionality: 768 } // Matryoshka para caber no pgvector HNSW
        });
        // O Supabase PostgREST aceita arrays regulares de números para campos pgvector
        return result.embeddings?.[0]?.values ?? null;
    } catch (e) {
        logger.error({ e, texto }, '[Embedding] Erro ao gerar vetor');
        return null;
    }
}

// ============================================================
// BUSCA DE SIMILARES (pg_trgm + Gemini semântico)
// ============================================================

/**
 * Busca produtos similares:
 * 1ª peneira: pg_trgm (matemática, rápida, barata)
 * 2ª peneira: Gemini (semântica) sobre o conjunto reduzido
 * Fallback: varredura total se pg_trgm não estiver ativo (graceful degradation)
 */
export async function buscarProdutosSimilares(
    lojaId: string,
    termoBusca: string
): Promise<Array<{ id: string; produto_nome: string; preco: number; unidade: string }>> {

    let candidatos: any[] = [];

    // ── Etapa 1: Peneira matemática via pg_trgm RPC ──
    try {
        const { data: trgmData, error: trgmError } = await supabase
            .rpc('buscar_produtos_similares', {
                p_loja_id:   lojaId,
                p_termo:     termoBusca,
                p_threshold: 0.15,
            });

        if (!trgmError && trgmData && trgmData.length > 0) {
            candidatos = trgmData;
            logger.info({ lojaId, termoBusca, candidatos: candidatos.length }, '[Similares] pg_trgm retornou candidatos');
        } else if (trgmError) {
            logger.warn({ err: trgmError.message }, '[Similares] pg_trgm indisponível, usando full-scan');
        }
    } catch (err) {
        logger.warn({ err }, '[Similares] Erro no pg_trgm, degradando para full-scan');
    }

    // ── Fallback: full-scan em catalogo_ativo ──
    if (candidatos.length === 0) {
        const { data, error } = await supabase
            .from('catalogo_ativo')
            .select('id, produto_nome, preco, unidade, atualizado_em')
            .eq('loja_id', lojaId)
            .eq('disponivel', true);

        if (error || !data || data.length === 0) return [];
        candidatos = data;
        logger.info({ lojaId, totalProdutos: candidatos.length }, '[Similares] Full-scan em catalogo_ativo ativado');
    }

    if (candidatos.length === 0) return [];

    // ── Etapa 2: Lupa semântica Gemini sobre os candidatos ──
    const catalogList = candidatos
        .map((p: any, i: number) => `${i + 1}. ${p.produto_nome} (R$ ${p.preco} / ${p.unidade})`)
        .join('\n');

    try {
        const result = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: `Você é um analista estrito de similaridade de produtos.
Produto buscado: "${termoBusca}"

Encontre na lista abaixo quais itens são o MESMO PRODUTO que o buscado.
- Considere erros ortográficos comuns em WhatsApp (ex: "Aros" e "Arroz", "Mussa" e "Muçarela").
- Considere sinônimos ou abreviações CLARAS (ex: "Refri" e "Refrigerante", "Massa" e "Macarrão").
- CUIDADO: Falsos positivos são intoleráveis. Se o produto for de tipo diferente, NÃO TEM SIMILARIDADE.
- Retorne APENAS um array JSON de índices (começando em 1) com as correspondências encontradas.
- Se não houver NENHUM correspondente seguro, retorne um array vazio: []

Catálogo:
${catalogList}

JSON:`,
            config: { responseMimeType: 'application/json' },
        });
        logTokens('buscar_similares_gemini', lojaId, lojaId, result.usageMetadata);

        const indices = parseSafe(IndicesSimilaresSchema, result.text || '[]', []);
        return indices
            .filter((idx: number) => idx >= 1 && idx <= candidatos.length)
            .map((idx: number) => candidatos[idx - 1]);
    } catch (e) {
        logger.error({ e }, '[Similares] Erro no Gemini semântico');
        return [];
    }
}

// ============================================================
// INGESTÃO (UPSERT + histórico)
// ============================================================

/**
 * Ingere produto no catalogo_ativo via UPSERT.
 * Se houve mudança de preço, registra trilha de auditoria no catalogo_historico.
 * Deduplication: ignora se mesmo nome+preço já está ativo.
 */
export async function ingeriCatalogo(lojaId: string, produto: DadosProduto, fonte: string = 'manual'): Promise<{ inserido: boolean }> {
    const nomeSeguro    = produto.nome.substring(0, 250);
    const unidadeSegura = (produto.unidade || 'un').substring(0, 30);

    const { data: ativo } = await supabase
        .from('catalogo_ativo')
        .select('id, preco')
        .eq('loja_id', lojaId)
        .ilike('produto_nome', nomeSeguro)
        .eq('disponivel', true)
        .limit(1)
        .maybeSingle();

    const precoMudou = !ativo || Math.abs(Number(ativo.preco) - produto.preco) > 0.001;

    if (!precoMudou && ativo) {
        logger.info({ lojaId, nome: nomeSeguro }, '[Ledger] Renovando selo de frescor (preço igual)');
        await supabase
            .from('catalogo_ativo')
            .update({ atualizado_em: new Date().toISOString() })
            .eq('id', ativo.id);
        return { inserido: false };
    }

    const textoParaVetor = `${nomeSeguro} ${unidadeSegura}`.trim();
    const vetorInfo = await gerarEmbedding(textoParaVetor);

    const { data: upserted, error: upsertError } = await supabase
        .from('catalogo_ativo')
        .upsert(
            {
                loja_id:        lojaId,
                produto_nome:   nomeSeguro,
                preco:          produto.preco,
                unidade:        unidadeSegura,
                disponivel:     true,
                fonte_ingestao: fonte,
                atualizado_em:  new Date().toISOString(),
                ...(vetorInfo ? { embedding: vetorInfo } : {})
            },
            { onConflict: 'loja_id,produto_nome', ignoreDuplicates: false }
        )
        .select('id')
        .single();

    if (upsertError || !upserted) {
        logger.error({ error: upsertError }, '[Ledger] Erro no UPSERT de catalogo_ativo');
        throw new Error('Falha ao gravar produto no banco.');
    }

    await supabase.from('catalogo_historico').insert({
        loja_id:        lojaId,
        produto_id:     upserted.id,
        produto_nome:   nomeSeguro,
        preco:          produto.preco,
        unidade:        unidadeSegura,
        disponivel:     true,
        fonte_ingestao: fonte,
    });

    return { inserido: true };
}

// ============================================================
// ATUALIZAÇÃO DE PREÇO (UPSERT com fallback defensivo)
// ============================================================

/**
 * Atualiza preço no snapshot (catalogo_ativo via UPSERT) e
 * registra o evento de mudança no ledger histórico (append-only).
 */
export async function atualizarPrecoLedger(lojaId: string, produtoNome: string, novoPreco: number, unidade: string): Promise<void> {
    if (!produtoNome || !lojaId) {
        logger.error({ lojaId, produtoNome }, '[Ledger] atualizarPrecoLedger chamado com dados inválidos');
        throw new Error('Dados inválidos para atualizar preço.');
    }
    const nomeSeguro    = String(produtoNome).substring(0, 250);
    const unidadeSegura = String(unidade || 'un').substring(0, 30);
    const precoSeguro   = Number(novoPreco) || 0;
    const agora         = new Date().toISOString();

    const textoParaVetor = `${nomeSeguro} ${unidadeSegura}`.trim();
    const vetorInfo = await gerarEmbedding(textoParaVetor);

    let upserted: { id: string } | null = null;

    const { data: tentativa1, error: erro1 } = await supabase
        .from('catalogo_ativo')
        .upsert(
            {
                loja_id:        lojaId,
                produto_nome:   nomeSeguro,
                preco:          precoSeguro,
                unidade:        unidadeSegura,
                disponivel:     true,
                fonte_ingestao: 'manual',
                atualizado_em:  agora,
                ...(vetorInfo ? { embedding: vetorInfo } : {})
            },
            { onConflict: 'loja_id,produto_nome', ignoreDuplicates: false }
        )
        .select('id')
        .single();

    if (erro1?.code === 'PGRST204' || erro1?.code === '42703') {
        logger.warn({ lojaId, erro1 }, '[Ledger] Erro no upsert, tentando fallback defensivo');
        const { data: tentativa2, error: erro2 } = await supabase
            .from('catalogo_ativo')
            .upsert(
                {
                    loja_id:        lojaId,
                    produto_nome:   nomeSeguro,
                    preco:          precoSeguro,
                    unidade:        unidadeSegura,
                    disponivel:     true,
                    fonte_ingestao: 'manual',
                    atualizado_em:  agora,
                    ...(vetorInfo ? { embedding: vetorInfo } : {})
                },
                { onConflict: 'loja_id,produto_nome', ignoreDuplicates: false }
            )
            .select('id')
            .single();

        if (erro2) {
            logger.error({ error: erro2 }, '[Ledger] Erro ao atualizar preço em catalogo_ativo');
            throw new Error('Falha ao atualizar preço.');
        }
        upserted = tentativa2;
    } else if (erro1) {
        logger.error({ error: erro1 }, '[Ledger] Erro ao atualizar preço em catalogo_ativo');
        throw new Error('Falha ao atualizar preço.');
    } else {
        upserted = tentativa1;
    }

    await supabase.from('catalogo_historico').insert({
        loja_id:        lojaId,
        produto_id:     upserted?.id,
        produto_nome:   nomeSeguro,
        preco:          precoSeguro,
        unidade:        unidadeSegura,
        disponivel:     true,
        fonte_ingestao: 'manual',
    });
}

// ============================================================
// SOFT DELETE (retirar do estoque)
// ============================================================

/**
 * Soft Delete: marca produto como indisponível no snapshot (catalogo_ativo)
 * e registra o evento de remoção na trilha de auditoria (catalogo_historico).
 */
export async function retirarEstoqueLedger(lojaId: string, produtoNome: string, unidadeConhecida: string): Promise<void> {
    const { data: ativo } = await supabase
        .from('catalogo_ativo')
        .select('id, preco, unidade, disponivel')
        .eq('loja_id', lojaId)
        .ilike('produto_nome', `%${produtoNome}%`)
        .limit(1)
        .maybeSingle();

    if (ativo && ativo.disponivel === false) {
        logger.info({ lojaId, produtoNome }, '[Ledger] Produto já fora de estoque — sem ação');
        return;
    }

    const precoConhecido        = ativo?.preco ?? 0;
    const unidadeConhecidaFinal = (ativo?.unidade || unidadeConhecida || 'un').substring(0, 30);
    const nomeSeguro            = produtoNome.substring(0, 250);

    if (ativo?.id) {
        const { error: updateError } = await supabase
            .from('catalogo_ativo')
            .update({ disponivel: false })
            .eq('id', ativo.id);

        if (updateError) {
            logger.error({ error: updateError }, '[Ledger] Erro no Soft Delete em catalogo_ativo');
            throw new Error('Falha ao retirar produto do estoque.');
        }
    }

    await supabase.from('catalogo_historico').insert({
        loja_id:        lojaId,
        produto_id:     ativo?.id,
        produto_nome:   nomeSeguro,
        preco:          precoConhecido,
        unidade:        unidadeConhecidaFinal,
        disponivel:     false,
        fonte_ingestao: 'manual',
    });
}
