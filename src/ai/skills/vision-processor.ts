/**
 * Skill: vision-processor
 * Responsabilidade: Processamento multimodal (foto e áudio) incluindo:
 * - Download e validação da mídia
 * - Extração de múltiplos produtos via Gemini Vision
 * - Montagem do resumo de lote (processLoteProdutos)
 * Reutilizado pelo orchestrator tanto na ingestão proativa quanto no fluxo de dados pendentes.
 */

import { Part } from '@google/genai';
import { sendTextMessage, sendInteractiveButtons, sendReaction, type WhatsAppMessage, downloadMedia } from '../../lib/whatsapp.js';
import { salvarContexto, limparContexto, renovarTTLContexto, liberarLock } from '../../lib/redis-cloud.js';
import { ai, GEMINI_MODEL } from '../../lib/gemini.js';
import { logger, logTokens } from '../../lib/logger.js';
import { MultimodalExtraidoSchema, parseSafe } from '../schemas.js';
import { EstadosFluxo, DadosProduto, AlteracaoPlanejada, ContextoSessao } from '../types.js';
import { buscarProdutosSimilares } from './catalog-ledger.js';
import { calcularSeloFrescor } from './revisor.js';

const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

// ============================================================
// HELPER: Formata card visual de produto para resumo de lote
// ============================================================
export function formatarCartaoProduto(item: AlteracaoPlanejada, indice: number, fonte: 'texto' | 'foto' | 'audio' = 'texto'): string {
    const SEP = '───────────────';
    const num = `${indice + 1}.`;
    const precoFoto = `R$ ${item.precoFoto.toFixed(2).replace('.', ',')} / ${item.unidade}`;
    const rotuloFonte = fonte === 'foto' ? 'Foto' : fonte === 'audio' ? 'Áudio' : 'Digitado';

    const nomeExibido = (item.acao === 'preco_atualizado' || item.acao === 'sem_alteracao') && item.produtoExistente
        ? item.produtoExistente.produto_nome
        : item.nome;

    let card = `${SEP}\n`;

    if (item.acao === 'novo_cadastro') {
        card += `✅ ${num} *${item.nome}*\n`;
        card += `💰 Preço: *${precoFoto}*\n`;
        card += `📦 Novo cadastro`;
    } else if (item.acao === 'preco_atualizado' && item.produtoExistente) {
        const precoAntigo = `R$ ${item.produtoExistente.preco.toFixed(2).replace('.', ',')} / ${item.produtoExistente.unidade}`;
        const selo = calcularSeloFrescor(item.produtoExistente.atualizado_em);
        card += `🔄 ${num} *${nomeExibido}*\n`;
        card += `💰 ${rotuloFonte}: *${precoFoto}*\n`;
        card += `📦 Estoque: ${precoAntigo}\n`;
        card += `⏱️ Status: ${selo}\n`;
        card += `↪️ Atualizar preço`;
    } else if (item.acao === 'sem_alteracao' && item.produtoExistente) {
        const precoEstoque = `R$ ${item.produtoExistente.preco.toFixed(2).replace('.', ',')} / ${item.produtoExistente.unidade}`;
        const selo = calcularSeloFrescor(item.produtoExistente.atualizado_em);
        card += `⏭️ ${num} *${nomeExibido}*\n`;
        card += `💰 ${rotuloFonte}: *${precoFoto}*\n`;
        card += `📦 Estoque: ${precoEstoque}\n`;
        card += `⏱️ Status: ${selo}\n`;
        card += `Sem alteração (confirmado hoje)`;
    } else if (item.acao === 'ambiguo') {
        const numSimilares = item.similares?.length ?? '?';
        // Lista os nomes dos similares encontrados para o lojista saber exatamente o que o sistema viu
        const nomesSimilares = item.similares
            ?.slice(0, 4)
            .map(s => `• ${s.produto_nome} (R$ ${s.preco.toFixed(2).replace('.', ',')}/${s.unidade})`)
            .join('\n') ?? '';
        card += `⚠️ ${num} *${item.nome}*\n`;
        card += `💰 ${rotuloFonte}: *${precoFoto}*\n`;
        card += `📦 *${numSimilares} produto(s) parecido(s) no estoque:*\n`;
        if (nomesSimilares) card += `${nomesSimilares}\n`;
        card += `Use ✏️ Editar para escolher qual atualizar`;
    } else {
        card += `📌 ${num} *${item.nome}*\n`;
        card += `💰 ${rotuloFonte}: *${precoFoto}*`;
    }

    return card;
}

// ============================================================
// PROCESSAMENTO MULTIMODAL (foto / áudio)
// ============================================================
export async function processarMidia(msg: WhatsAppMessage, from: string, loja: any, contexto: ContextoSessao): Promise<void> {
    const lockKey = `lock:midia:${from}`;
    try {
        const MIME_PERMITIDOS = new Set(['image/jpeg', 'image/png', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/ogg; codecs=opus']);
        const TAMANHO_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

        const mediaInfo = (msg as any).image || (msg as any).audio || (msg as any).voice;
        if (!mediaInfo?.id) {
            await sendTextMessage(from, 'Não consegui processar esse tipo de arquivo. Por favor, *digite* os dados do produto.');
            return;
        }

        if (msg.id) sendReaction(from, msg.id, '🔍').catch(() => {});

        const mimeType: string = mediaInfo.mime_type ?? '';
        if (!MIME_PERMITIDOS.has(mimeType)) {
            await sendTextMessage(from, `⚠️ Formato não suportado (${mimeType}). Envie fotos JPEG/PNG ou áudios OGG/MP4, ou *digite* os dados.`);
            return;
        }

        const fileSize: number = mediaInfo.file_size ?? 0;
        if (fileSize > TAMANHO_MAX_BYTES) {
            await sendTextMessage(from, '⚠️ Arquivo muito pesado (máx 5MB). Por favor, envie uma foto menor ou *digite* os dados.');
            return;
        }

        try {
            await sendTextMessage(from, '👀 Recebi sua mídia! Me dê uns segundinhos enquanto leio os dados...\n\n💡 *Dica:* sabia que eu consigo ler dezenas de produtos numa *única foto* do seu cardápio de uma vez?');

            const buffer = await downloadMedia(mediaInfo.id);
            const base64 = buffer.toString('base64');

            const promptMultimodal = `Você é um extrator de dados de catálogo de supermercado/restaurante.
Analise a imagem/áudio e retorne APENAS um JSON.
Sua tarefa é extrair TODOS os produtos legíveis e inseri-los no array "itens".

Regras de escape:
- Se imagem estiver 100% embaçada/ilegível ou áudio for inaudível/ruído → {"legibilidade_baixa": true, "ruido_detectado": true, "itens": []}
- Se os dados estiverem visíveis/audíveis, extraia TODOS.

Nome em Title Case. Preço como número. Unidade máx 30 chars.
Se a unidade não estiver clara, use "un".
Formato de saída esperado:
{"legibilidade_baixa": false, "ruido_detectado": false, "itens": [{"nome": "Coca Cola 2L", "preco": 10.50, "unidade": "un"}, {"nome": "Guaraná Antártica", "preco": 8.00, "unidade": "un"}]}

JSON:`;

            const safeMimeType = mimeType.split(';')[0];
            const imgPart: Part = { inlineData: { data: base64, mimeType: safeMimeType } };
            const result = await ai.models.generateContent({
                model: GEMINI_MODEL,
                contents: [{ text: promptMultimodal }, imgPart],
                config: { responseMimeType: 'application/json' },
            });
            logTokens('multimodal_extracao', from, loja?.id ?? 'unknown', result.usageMetadata);
            const dados = parseSafe(MultimodalExtraidoSchema, result.text || '{}', { legibilidade_baixa: true } as any);

            if (dados.legibilidade_baixa) {
                await sendTextMessage(from, '📷 A foto/áudio ficou difícil de ler. Pode mandar novamente com mais nitidez?');
                await renovarTTLContexto(from);
                return;
            }
            if (dados.ruido_detectado || !('itens' in dados) || !dados.itens || dados.itens.length === 0) {
                const pendencia = contexto.perguntaPendente || 'Por favor, envie o Nome, Preço e Unidade do(s) produto(s).';
                await sendTextMessage(from, `Não encontrei produtos válidos na mídia. 😅\n\n${pendencia}`);
                await renovarTTLContexto(from);
                return;
            }

            const itensValidos: DadosProduto[] = dados.itens
                .filter((i: any) => i.nome && i.preco > 0)
                .map((i: any) => ({
                    nome:    String(i.nome).substring(0, 250),
                    preco:   i.preco as number,
                    unidade: String(i.unidade || 'un').substring(0, 30),
                }));

            if (itensValidos.length === 0) {
                await sendTextMessage(from, 'Nenhum produto válido foi encontrado na mídia. 😅');
                await renovarTTLContexto(from);
                return;
            }

            await sendTextMessage(from, `⏳ Verificando *${itensValidos.length}* produto(s) no estoque...`);

            const alteracoes: AlteracaoPlanejada[] = [];

            for (let i = 0; i < itensValidos.length; i++) {
                const item = itensValidos[i];
                if (!item.nome || item.preco <= 0) continue;

                const similares = await buscarProdutosSimilares(loja.id, item.nome);
                const alteracao: AlteracaoPlanejada = {
                    nome:      item.nome,
                    precoFoto: item.preco,
                    unidade:   item.unidade,
                    acao:      'sem_alteracao',
                };

                if (similares.length > 0) {
                    if (similares.length > 1) {
                        alteracao.similares = similares;
                        alteracao.acao = 'ambiguo';
                    } else {
                        const maisProximo = similares[0];
                        alteracao.produtoExistente = {
                            id:           maisProximo.id,
                            produto_nome: maisProximo.produto_nome,
                            preco:        maisProximo.preco,
                            unidade:      maisProximo.unidade,
                            atualizado_em: (maisProximo as any).atualizado_em ?? undefined,
                        };
                        // Herança inteligente: adota a unidade do catálogo se a extração foi genérica
                        if (alteracao.unidade === 'un' && maisProximo.unidade && maisProximo.unidade !== 'un') {
                            alteracao.unidade = maisProximo.unidade;
                        }
                        alteracao.acao = maisProximo.preco === item.preco ? 'sem_alteracao' : 'preco_atualizado';
                    }
                } else {
                    alteracao.acao = 'novo_cadastro';
                }

                alteracoes.push(alteracao);
            }

            if (alteracoes.length === 0) {
                await sendTextMessage(from, 'Nenhum produto válido encontrado.');
                await limparContexto(from);
                return;
            }

            await processLoteProdutos(from, loja, alteracoes, mimeType.startsWith('image') ? 'foto' : 'audio');

        } catch (err) {
            logger.error({ err, from }, '[Erro multimodal]');
            await sendTextMessage(from, '😕 Não consegui processar o arquivo. Por favor, *digite* o Nome, Preço e Unidade do produto.');
            await renovarTTLContexto(from);
        }
    } finally {
        await liberarLock(lockKey);
    }
}

// ============================================================
// CONFIRMAÇÃO E RESUMO DE LOTE
// ============================================================

/**
 * Consolida as alterações planejadas, gera o card de resumo
 * e envia os botões de confirmação.
 * Reutilizado após extração e após edições manuais do lojista.
 */
export async function processLoteProdutos(from: string, loja: any, alteracoes: AlteracaoPlanejada[], fonte: 'foto' | 'audio' | 'manual' = 'manual'): Promise<void> {
    const listaAtiva = alteracoes.filter(a => a.acao !== 'remover');

    if (listaAtiva.length === 0) {
        await sendTextMessage(from, 'Ø A lista de produtos está vazia.');
        await limparContexto(from);
        return;
    }

    const totalNovos     = listaAtiva.filter(a => a.acao === 'novo_cadastro').length;
    const totalAtualizar = listaAtiva.filter(a => a.acao === 'preco_atualizado').length;
    const totalIgual     = listaAtiva.filter(a => a.acao === 'sem_alteracao').length;
    const totalAmbiguo   = listaAtiva.filter(a => a.acao === 'ambiguo').length;

    const cards = listaAtiva.slice(0, 30).map((a, i) =>
        formatarCartaoProduto(a, i, fonte === 'manual' ? 'foto' : fonte)
    ).join('\n');
    const sufixo = listaAtiva.length > 30 ? `\n\n...e mais ${listaAtiva.length - 30} item(s).` : '';

    const contLinhas: string[] = [];
    if (totalNovos > 0)     contLinhas.push(`✅ ${totalNovos} novo(s)`);
    if (totalAtualizar > 0) contLinhas.push(`🔄 ${totalAtualizar} atualizar`);
    if (totalIgual > 0)     contLinhas.push(`⏭️ ${totalIgual} sem alteração`);
    if (totalAmbiguo > 0)   contLinhas.push(`⚠️ ${totalAmbiguo} ambíguo(s)`);

    let resumo = `📋 *Resumo Atualizado — ${listaAtiva.length} produto(s)*\n`;
    resumo += contLinhas.join('  |  ') + '\n\n';
    resumo += cards + sufixo;

    await salvarContexto(from, {
        estado:              EstadosFluxo.AGUARDANDO_CONFIRMACAO_ALTERACOES,
        alteracoesPlanejadas: alteracoes,
    });

    await sendTextMessage(from, resumo);
    await delay(300);
    await sendInteractiveButtons(from, `⚡ Confirma as alterações acima?`, [
        { id: 'confirmar_alteracoes_sim', title: '✅ Confirmar Todos' },
        { id: 'editar_item_lista',        title: '✏️ Editar um Item' },
        { id: 'confirmar_alteracoes_nao', title: '❌ Cancelar Tudo' },
    ]);
}
