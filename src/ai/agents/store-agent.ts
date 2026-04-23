/**
 * src/ai/agents/store-agent.ts
 * Agente responsável pelos serviços da loja:
 * - Fluxo de criação de ofertas (AGUARDANDO_DADOS_OFERTA)
 * - Revisão de preços (AGUARDANDO_SELECAO_REVISAO)
 * - Navegação pelo menu principal (botões menu_*)
 */

import {
    sendTextMessage,
    sendInteractiveButtons,
    type WhatsAppMessage,
} from '../../lib/whatsapp.js';
import { salvarContexto, limparContexto } from '../../lib/redis-cloud.js';
import { EstadosFluxo, ContextoSessao, AlteracaoPlanejada, DadosProduto } from '../types.js';
import { logger, logTokens } from '../../lib/logger.js';
import { OfertaExtraidaSchema, parseSafe } from '../schemas.js';
import { ai, GEMINI_MODEL } from '../../lib/gemini.js';
import { obterEstatisticas, criarOferta, buscarOfertasAtivas } from '../skills/store-services.js';
import { processarRevisaoPrecos, calcularSeloFrescor } from '../skills/revisor.js';
import { atualizarPrecoLedger } from '../skills/catalog-ledger.js';
import { enviarMenu } from '../shared.js';

const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

export async function handleStore(
    msg: WhatsAppMessage,
    from: string,
    loja: any,
    contexto: ContextoSessao | null,
    userMessageText: string,
    buttonId: string,
    isInteractive: boolean,
    isTextOnly: boolean,
): Promise<boolean> {

    if (!loja) return false;

    // ── MENU: botões menu_* ───────────────────────────────────────────────────
    if (isInteractive && buttonId.startsWith('menu_')) {
        const acao = buttonId.replace('menu_', '');

        if (acao === 'revisar') {
            await processarRevisaoPrecos(from, loja);
            return true;
        }

        if (acao === 'cadastrar' || acao === 'revisar_renovar') {
            const msgInstrucao = acao === 'revisar_renovar'
                ? 'Ótimo! Vamos renovar seus preços. Você pode:\n\n📷 Mandar uma *única foto* de todo o encarte ou cardápio (eu atualizo vários de uma vez!)\n🎙️ Mandar um *áudio* rápido\n✍️ Ou *digitar* os novos valores (ex: Arroz 8,50)\n\nEstou aguardando!'
                : 'Ótimo! Para cadastrar ou atualizar, você pode:\n\n📷 Mandar uma *única foto* de todo o encarte ou cardápio (eu leio vários de uma vez!)\n🎙️ Mandar um *áudio*\n✍️ Ou *digitar* o nome e preço (ex: Feijão 10,00)\n\nO que deseja enviar?';
            await salvarContexto(from, {
                estado: EstadosFluxo.AGUARDANDO_DADOS_PRODUTO,
                acao: acao,
                perguntaPendente: msgInstrucao,
                retries: 0,
            });
            await sendTextMessage(from, msgInstrucao);
            return true;
        }

        if (acao === 'ofertas') {
            await salvarContexto(from, {
                estado: EstadosFluxo.AGUARDANDO_DADOS_OFERTA,
                acao: 'criar_oferta',
                perguntaPendente: 'Envie: Valor mínimo (R$), Percentual de desconto (%) e Data de validade (DD/MM/AAAA).',
                retries: 0,
            });
            await sendTextMessage(from, 'Para criar uma oferta, envie:\n*Valor mínimo* (R$) | *Percentual* (%) | *Validade* (DD/MM/AAAA)\n\nEx: 80 reais, 10%, validade 30/04/2026');
            return true;
        }

        if (acao === 'estatisticas') {
            const stats = await obterEstatisticas(loja.id);
            await sendTextMessage(from, `📊 *Estatísticas da sua loja:*\n\nSaldo de cliques: ${stats.saldo}\nStatus: ${stats.status}\nCliques (30 dias): ${stats.cliques_30d}`);
            await delay(500);
            await enviarMenu(loja.nome, from);
            return true;
        }

        if (acao === 'ver_ativas') {
            const ofertas = await buscarOfertasAtivas(loja.id);
            if (ofertas.length === 0) {
                await sendTextMessage(from, 'Você não tem ofertas ativas no momento.');
            } else {
                let texto = '📢 *Suas ofertas ativas:*\n\n';
                for (const o of ofertas) {
                    texto += `• A partir de R$ ${o.valor_minimo} → ${o.percentual}% off (até ${o.validade})\n`;
                }
                await sendTextMessage(from, texto);
            }
            await delay(500);
            await enviarMenu(loja.nome, from);
            return true;
        }

        return false; // menu_ desconhecido — deixa o InventoryAgent tentar
    }

    // ── AGUARDANDO_DADOS_OFERTA ───────────────────────────────────────────────
    if (contexto?.estado === EstadosFluxo.AGUARDANDO_DADOS_OFERTA) {
        if (isInteractive) return true;
        if (!userMessageText.trim()) {
            await sendTextMessage(from, 'Por favor, envie os dados da oferta em texto.');
            return true;
        }

        const prompt = `Extraia os dados da oferta. Responda APENAS JSON.\nRegras:\n1. Vírgula → ponto nos números\n2. Percentual: 0-100\n3. Data: YYYY-MM-DD\n\nRetorne: {"valor_minimo": numero, "percentual": numero, "validade": "YYYY-MM-DD", "produto_filtro": "string ou null"}\n\nMensagem: "${userMessageText}"\n\nJSON:`;

        try {
            const result = await ai.models.generateContent({
                model: GEMINI_MODEL,
                contents: prompt,
                config: { responseMimeType: 'application/json' },
            });
            logTokens('extrair_oferta', from, loja?.id ?? 'unknown', result.usageMetadata);
            const dados = parseSafe(OfertaExtraidaSchema, result.text || '{}', null as any);
            if (!dados) throw new Error('Dados da oferta inválidos ou incompletos');

            await criarOferta(loja.id, dados);
            await sendTextMessage(from, `✅ Oferta criada! *${dados.percentual}%* de desconto para compras acima de R$ ${dados.valor_minimo}. Válido até ${dados.validade}.`);
            await limparContexto(from);
            await delay(400);
            await enviarMenu(loja.nome, from);
        } catch (err) {
            logger.error({ err, from }, '[StoreAgent] Erro ao processar oferta');
            await sendTextMessage(from, 'Não consegui criar a oferta. Envie: Valor mínimo (R$), Percentual (%) e Data de validade.');
        }
        return true;
    }

    // ── AGUARDANDO_SELECAO_REVISAO ────────────────────────────────────────────
    if (contexto?.estado === EstadosFluxo.AGUARDANDO_SELECAO_REVISAO) {
        const lista: AlteracaoPlanejada[] = contexto.alteracoesPlanejadas ?? [];

        const pairsRegex = /(\d+)[\s\-:=>*\/]+([\d]+[.,][\d]{1,2}|[\d]+)/g;
        const pares: { idx: number; preco: number }[] = [];
        let match: RegExpExecArray | null;

        while ((match = pairsRegex.exec(userMessageText)) !== null) {
            const idx   = parseInt(match[1]!, 10);
            const preco = parseFloat(match[2]!.replace(',', '.'));
            if (!isNaN(idx) && !isNaN(preco) && idx >= 1 && idx <= lista.length && preco > 0) {
                pares.push({ idx, preco });
            }
        }

        if (isTextOnly && pares.length > 0) {
            const resultados: string[] = [];
            for (const par of pares) {
                const item = lista[par.idx - 1]!;
                await atualizarPrecoLedger(loja.id, item.nome, par.preco, item.unidade);
                resultados.push(`✅ *${par.idx}. ${item.nome}* → R$ ${par.preco.toFixed(2).replace('.', ',')} / ${item.unidade}`);
                item.acao = 'sem_alteracao';
                item.precoFoto = par.preco;
            }

            const atualizadosIds = new Set(pares.map(p => p.idx));
            const pendentes = lista.filter((_: AlteracaoPlanejada, i: number) => !atualizadosIds.has(i + 1));
            const feedbackMsg = `*Preços atualizados:*\n` + resultados.join('\n');

            if (pendentes.length === 0) {
                await sendTextMessage(from, feedbackMsg + '\n\n🎉 *Todos os preços estão atualizados!* Obrigado por manter seu catálogo fresquinho.');
                await limparContexto(from);
                await delay(400);
                await enviarMenu(loja.nome, from);
            } else {
                let novaLista = `${feedbackMsg}\n\n📋 *Ainda pendentes:*\n`;
                pendentes.forEach((item: AlteracaoPlanejada) => {
                    const idxOriginal = lista.indexOf(item) + 1;
                    const selo = calcularSeloFrescor(undefined);
                    novaLista += `*${idxOriginal}. ${item.nome}* — R$ ${item.precoFoto.toFixed(2).replace('.', ',')} / ${item.unidade} ${selo}\n`;
                });
                novaLista += `\n✏️ _Ex: *${pendentes.map((_: AlteracaoPlanejada, i: number) => `${lista.indexOf(pendentes[i]!) + 1} 0,00`).slice(0, 2).join(' ')}_`;
                await salvarContexto(from, { ...contexto, alteracoesPlanejadas: lista });
                await sendTextMessage(from, novaLista);
            }
            return true;
        }

        if (isTextOnly && userMessageText.trim().length > 0) {
            const exemplo = lista.slice(0, 2).map((_: AlteracaoPlanejada, i: number) => `*${i + 1} - 0,00*`).join('\n');
            await sendTextMessage(from,
                `✍️ *Como atualizar preços:*\n` +
                `Digite o número do item e o novo preço. Pode mandar um embaixo do outro:\n\n` +
                `Exemplo:\n${exemplo}\n\n` +
                `_Para voltar ao menu, digite *cancelar*._`
            );
            await delay(300);
            await sendInteractiveButtons(from, 'Ou prefere sair agora?', [
                { id: 'btn_cancelar', title: '↩️ Voltar ao Menu' },
            ]);
            return true;
        }

        return false; // deixa o InventoryAgent tratar (ex: botão de confirmação)
    }

    return false;
}
