/**
 * Skill: catalog-ledger
 * Responsabilidade: Todas as operações de leitura e escrita no catálogo de produtos.
 * Inclui busca de similares (pgvector semântico), inserção (UPSERT) com 6 camadas
 * de precisão, atualização de preço e soft-delete via ledger append-only.
 */

import { supabaseAdmin as supabase } from '../../lib/supabase.js';
import { ai, GEMINI_MODEL } from '../../lib/gemini.js';
import { logger, logTokens } from '../../lib/logger.js';
import { IndicesSimilaresSchema, parseSafe } from '../schemas.js';
import { DadosProduto } from '../types.js';
import { z } from 'zod';

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
// DECOMPOSIÇÃO EM 6 CAMADAS DE PRECISÃO
// ============================================================

interface Camadas6 {
    membro_core: string | null;
    marca: string | null;
    especificacao: string | null;
    unidade_medida: string | null;
    metadados: Record<string, any> | null;
}

const Camadas6Schema = z.object({
    membro_core:    z.string().nullable().optional(),
    marca:          z.string().nullable().optional(),
    especificacao:  z.string().nullable().optional(),
    unidade_medida: z.string().nullable().optional(),
    metadados:      z.record(z.any()).nullable().optional(),
});

/**
 * Usa o Gemini para decompor o nome de um produto em 6 camadas estruturadas.
 * Isso mantém o banco de dados organizado e permite buscas semânticas precisas.
 * Exemplo: "Café Santa Clara Vácuo 250g" →
 *   { membro_core: "Café", marca: "Santa Clara", especificacao: "Vácuo", unidade_medida: "250g", metadados: null }
 */
export async function decomporProduto(nomeProduto: string): Promise<Camadas6> {
    const fallback: Camadas6 = { membro_core: nomeProduto, marca: null, especificacao: null, unidade_medida: null, metadados: null };
    try {
        const result = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: `Você é um analista de dados de supermercado. Decomponha o nome do produto abaixo em 5 atributos.
Nome: "${nomeProduto}"

Regras:
- membro_core: O nome genérico do produto (ex: "Arroz", "Café", "Sabão em Pó"). Obrigatório.
- marca: A marca comercial, se houver (ex: "Tio João", "Santa Clara"). Null se não houver.
- especificacao: Tipo ou preparo (ex: "Integral", "Vácuo", "Cristal", "Líquido"). Null se não houver.
- unidade_medida: Peso ou volume com a unidade (ex: "5kg", "250g", "1L"). Null se não houver.
- metadados: Objeto JSON com tags extras relevantes (ex: {"tags":["Orgânico","Gourmet"]}). Null se não houver.

Retorne APENAS um JSON com esses 5 campos:
{"membro_core":"...","marca":null,"especificacao":null,"unidade_medida":null,"metadados":null}`,
            config: { responseMimeType: 'application/json', temperature: 0.0 },
        });
        logTokens('decompor_produto_6camadas', 'system', 'system', result.usageMetadata);
        const dados = parseSafe(Camadas6Schema, result.text || '{}', {});
        return {
            membro_core:    dados.membro_core    ?? fallback.membro_core,
            marca:          dados.marca          ?? null,
            especificacao:  dados.especificacao  ?? null,
            unidade_medida: dados.unidade_medida ?? null,
            metadados:      dados.metadados      ?? null,
        };
    } catch (e) {
        logger.warn({ e, nomeProduto }, '[Ledger] Erro na decomposição — usando fallback');
        return fallback;
    }
}

// ============================================================
// BUSCA DE SIMILARES (pgvector + Reranking Gemini obrigatório)
// ============================================================

/**
 * Busca produtos similares dentro do estoque de uma loja.
 * Fluxo:
 *   1. Gera embedding → consulta pgvector (candidatos brutos)
 *   2. SEMPRE filtra os candidatos via Gemini (reranking) — descarta falsos positivos
 *   3. Fallback: full-scan + filtro Gemini se embedding falhar
 *
 * O Gemini é o árbitro final: mesmo que o pgvector retorne algo,
 * ele confirma se /**
 * Busca candidatos brutos via pgvector sem reranking.
 * Útil para processamento em lote onde o reranking será feito consolidado.
 */
export async function buscarSimilaresSemanticoRaw(lojaId: string, termoBusca: string): Promise<any[]> {
    const vetor = await gerarEmbedding(termoBusca);
    if (!vetor) return [];

    const { data: semanticos, error } = await supabase
        .rpc('buscar_similares_semantico', {
            p_loja_id:         lojaId,
            p_query_embedding: vetor,
            p_match_threshold: 0.45,
            p_limit:           15,
        });

    if (semanticos && semanticos.length > 0) {
        // Enriquecimento: busca atualizado_em em lote (não está no RPC por performance)
        const ids = semanticos.map((s: any) => s.id);
        const { data: enrichment } = await supabase
            .from('catalogo_ativo')
            .select('id, atualizado_em')
            .in('id', ids);

        const mapaDatas = new Map(enrichment?.map(e => [e.id, e.atualizado_em]) || []);

        return semanticos.map((s: any) => ({
            id:           s.id,
            produto_nome: s.produto_nome,
            preco:        s.preco,
            unidade:      s.unidade,
            // Campos de decomposição — agora retornados diretamente pelo RPC 023
            membro_core:   s.membro_core   ?? null,
            marca:         s.marca         ?? null,
            especificacao: s.especificacao ?? null,
            atualizado_em: mapaDatas.get(s.id) || null,
        }));
    }

    return [];
}

/**
 * Busca produtos similares dentro do estoque de uma loja.
 * Fluxo:
 *   1. Gera embedding → consulta pgvector (candidatos brutos)
 *   2. SEMPRE filtra os candidatos via Gemini (reranking) — descarta falsos positivos
 *   3. Fallback: full-scan + filtro Gemini se embedding falhar
 *
 * O Gemini é o árbitro final: mesmo que o pgvector retorne algo,
 * ele confirma se o item é realmente o mesmo produto buscado.
 */
export async function buscarProdutosSimilares(
    lojaId: string,
    termoBusca: string,
    modo: 'cadastro' | 'busca_ampla' = 'cadastro'
): Promise<Array<{ id: string; produto_nome: string; preco: number; unidade: string; atualizado_em?: string | null }>> {

    let candidatos = await buscarSimilaresSemanticoRaw(lojaId, termoBusca);

    // ── Fallback: full-scan se embedding falhou ou não retornou nada ──
    if (candidatos.length === 0) {
        const { data, error: scanError } = await supabase
            .from('catalogo_ativo')
            .select('id, produto_nome, preco, unidade, atualizado_em')
            .eq('loja_id', lojaId)
            .eq('disponivel', true);

        if (scanError || !data || data.length === 0) return [];
        logger.info({ lojaId, total: data.length }, '[Similares] Full-scan ativado');
        candidatos = data;
    }

    // ── Etapa 2: Reranking OBRIGATÓRIO via Gemini ──
    // O Gemini valida cada candidato com campos estruturados (marca, membro_core, especificacao)
    // para garantir rejeição determinística de produtos de marcas ou tipos diferentes.
    const catalogList = candidatos
        .map((p: any, i: number) => {
            const core  = p.membro_core   ? `core: ${p.membro_core}`     : '';
            const marca = p.marca         ? `marca: ${p.marca}`          : '';
            const espec = p.especificacao ? `tipo: ${p.especificacao}`   : '';
            const attrs = [core, marca, espec].filter(Boolean).join(' | ');
            return `${i + 1}. ${p.produto_nome} (R$ ${p.preco} / ${p.unidade})${attrs ? ` [${attrs}]` : ''}`;
        })
        .join('\n');

    const promptCadastro = `O lojista quer cadastrar/atualizar o produto: "${termoBusca}".
Identifique no estoque abaixo QUAIS itens são EXATAMENTE o mesmo produto ou uma variação direta.

REGRAS (em ordem de prioridade):
1. MARCA: Se o termo buscado contém uma marca (ex: "Ninho", "Itambé"), SOMENTE aceite candidatos da MESMA marca.
2. ESPECIFICAÇÃO: Se o termo contém tipo ou preparo (ex: "Integral"), REJEITE candidatos com tipo diferente.
3. GENÉRICO: Se a busca for genérica sem marca (ex: apenas "Café"), selecione todos os cafés da lista. Só descarte se for algo totalmente diferente.`;

    const promptBuscaAmpla = `O usuário pesquisou por: "${termoBusca}".
Seu objetivo é atuar como um filtro de relevância para remover falsos positivos bizarros.
Selecione TODOS os itens do estoque abaixo que sejam de fato correspondentes ao termo buscado.

REGRAS:
1. Se o usuário buscou uma categoria ampla (ex: "Leite", "Arroz", "Cerveja"), RETORNE TODOS os itens que pertencem a essa categoria.
2. Se o usuário buscou um item específico (ex: "Leite Ninho"), RETORNE APENAS itens que batam com a especificação.
3. REJEITE FALSOS POSITIVOS GROSSEIROS (ex: se buscou "Leite", NÃO retorne "Óleo de Soja" ou "Doce de Leite").`;

    const instructions = modo === 'cadastro' ? promptCadastro : promptBuscaAmpla;

    try {
        const result = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: `Você é um especialista em catálogos de supermercado.\n\n${instructions}

Estoque:
${catalogList}

Retorne APENAS um array JSON com os índices (ex: [1, 2]), ou [] se nenhum candidato atender às regras acima.`,
            config: { responseMimeType: 'application/json', temperature: 0.0 },
        });
        logTokens('buscar_similares_reranking_gemini', lojaId, lojaId, result.usageMetadata);

        const indices = parseSafe(IndicesSimilaresSchema, result.text || '[]', []);
        const filtrados = indices
            .filter((idx: number) => idx >= 1 && idx <= candidatos.length)
            .map((idx: number) => {
                const c = candidatos[idx - 1];
                return {
                    id:           c.id,
                    produto_nome: c.produto_nome,
                    preco:        c.preco,
                    unidade:      c.unidade,
                    atualizado_em: (c as any).atualizado_em ?? null,
                };
            });

        return filtrados;
    } catch (e) {
        logger.error({ e }, '[Similares] Erro no reranking Gemini — retornando vazio por segurança');
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

    // Enriquecimento inteligente: só consome Gemini se o produto for REALMENTE novo ou mudou de nome
    let vetorInfo = (ativo as any)?.embedding ?? null;
    let camadas: Camadas6 = {
        membro_core:    (ativo as any)?.membro_core    ?? null,
        marca:          (ativo as any)?.marca          ?? null,
        especificacao:  (ativo as any)?.especificacao  ?? null,
        unidade_medida: (ativo as any)?.unidade_medida ?? null,
        metadados:      (ativo as any)?.metadados      ?? null,
    };

    if (!ativo || !camadas.membro_core) {
        // Produto novo ou sem camadas: faz o enriquecimento completo
        const textoParaVetor = `${nomeSeguro} ${unidadeSegura}`.trim();
        const [v, c] = await Promise.all([
            gerarEmbedding(textoParaVetor),
            decomporProduto(nomeSeguro),
        ]);
        vetorInfo = v;
        camadas = c;
    }

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
                // 6 camadas de precisão
                membro_core:    camadas.membro_core,
                marca:          camadas.marca,
                especificacao:  camadas.especificacao,
                unidade_medida: camadas.unidade_medida,
                metadados:      camadas.metadados || {},
                produto_sku:    `${lojaId}-${nomeSeguro.toLowerCase().replace(/\s+/g, '-')}`.substring(0, 100),
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
        membro_core:    camadas.membro_core,
        marca:          camadas.marca,
        especificacao:  camadas.especificacao,
        unidade_medida: camadas.unidade_medida,
        metadados:      camadas.metadados,
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
