import { type WhatsAppMessage, sendTextMessage, sendInteractiveButtons } from '../../lib/whatsapp.js';
import { limparContexto, salvarContexto, renovarTTLContexto } from '../../lib/redis-cloud.js';
import { logger } from '../../lib/logger.js';
import { EstadosFluxo, type ContextoSessao, type AlteracaoPlanejada } from '../types.js';
import { atualizarPrecoLedger } from '../skills/catalog-ledger.js';
import { processarRevisaoPrecos, calcularSeloFrescor } from '../skills/revisor.js';
import { enviarMenu } from '../shared.js';

const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

/**
 * Agente de Revisão de Preços (Fase 2 - Modularização)
 * Gerencia o fluxo de validade e revisão de preços pendentes.
 */
export async function handleRevisor(
    msg: WhatsAppMessage,
    from: string,
    loja: any,
    contexto: ContextoSessao | null,
    userMessageText: string,
    buttonId: string,
    isInteractive: boolean,
    isTextOnly: boolean,
    isMediaOnly: boolean
): Promise<boolean> {
    if (!loja || !contexto) return false;
    if (contexto.estado !== EstadosFluxo.AGUARDANDO_SELECAO_REVISAO) return false;

    const lista = (contexto.alteracoesPlanejadas || []) as AlteracaoPlanejada[];
    const indiceAtual = contexto.revisaoIndice ?? 0;
    const itemAtual = lista[indiceAtual];

    // 1. Tratamento de Botões de Confirmação Rápida
    if (isInteractive && (buttonId === 'btn_revisar_manter' || buttonId === 'btn_revisar_pular')) {
        if (buttonId === 'btn_revisar_manter' && itemAtual) {
            // Confirmou o preço atual -> atualiza updated_at no banco
            await atualizarPrecoLedger(loja.id, itemAtual.nome, itemAtual.precoFoto, itemAtual.unidade);
        }

        // Avança para o próximo
        return await avançarRevisao(from, loja, contexto, lista, indiceAtual + 1);
    }

    // 2. Tratamento de Clique em "Finalizar"
    if (isInteractive && buttonId === 'btn_revisar_finalizar') {
        await sendTextMessage(from, '✅ Revisão finalizada! Seu estoque está com os selos de frescor em dia.');
        await limparContexto(from);
        await delay(400);
        await enviarMenu(loja.nome, from);
        return true;
    }

    // 3. Tratamento de Preço Digitado
    if (isTextOnly && userMessageText.trim()) {
        const precoNum = parseFloat(userMessageText.replace(',', '.'));
        
        if (!isNaN(precoNum) && precoNum > 0) {
            if (precoNum > 5000) {
                await sendTextMessage(from, `⚠️ O valor de R$ ${precoNum.toFixed(2).replace('.', ',')} parece muito alto. Por segurança, digite novamente ou verifique a vírgula.`);
                return true;
            }

            if (itemAtual) {
                await atualizarPrecoLedger(loja.id, itemAtual.nome, precoNum, itemAtual.unidade);
                await sendTextMessage(from, `✅ *${itemAtual.nome}* atualizado para R$ ${precoNum.toFixed(2).replace('.', ',')}`);
            }

            return await avançarRevisao(from, loja, contexto, lista, indiceAtual + 1);
        }

        // Se digitou 0, cancela
        if (userMessageText.trim() === '0') {
            await sendTextMessage(from, 'Revisão interrompida.');
            await limparContexto(from);
            await delay(400);
            await enviarMenu(loja.nome, from);
            return true;
        }

        await sendTextMessage(from, '🤔 Não entendi o preço. Digite apenas o valor (Ex: 10,50) ou use os botões abaixo.');
        return true;
    }

    return true;
}

/**
 * Helper para avançar o índice da revisão e enviar a próxima pergunta
 */
async function avançarRevisao(from: string, loja: any, contexto: any, lista: any[], novoIndice: number): Promise<boolean> {
    if (novoIndice >= lista.length) {
        await sendTextMessage(from, '🎉 *Parabéns!* Você revisou todos os itens desta lista.');
        await limparContexto(from);
        await delay(400);
        // Verifica se ainda tem mais no banco (paginação automática)
        await processarRevisaoPrecos(from, loja);
        return true;
    }

    const proximoItem = lista[novoIndice];
    const selo = calcularSeloFrescor(proximoItem.dataReferencia);
    const precoFormatado = proximoItem.precoFoto.toFixed(2).replace('.', ',');

    await salvarContexto(from, {
        ...contexto,
        revisaoIndice: novoIndice
    });

    const msg = `Item ${novoIndice + 1} de ${lista.length}:\n\n*${proximoItem.nome}*\n💰 Preço atual: R$ ${precoFormatado} / ${proximoItem.unidade}\n⏱️ Status: ${selo}\n\nO preço continua o mesmo ou mudou?`;

    await sendInteractiveButtons(from, msg, [
        { id: 'btn_revisar_manter', title: '✅ É o mesmo' },
        { id: 'btn_revisar_pular',  title: '⏭️ Pular' },
        { id: 'btn_revisar_finalizar', title: '🏁 Finalizar' }
    ]);

    return true;
}
