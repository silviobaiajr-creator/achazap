import { boss } from '../queue/pgBossClient.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { sendTextMessage } from '../lib/whatsapp.js';
import { logger } from '../lib/logger.js';

/**
 * Worker que processa a verificação diária de validade dos preços.
 * Identifica lojistas com produtos vencendo o selo verde e envia um alerta.
 */
export async function startValidityWorker() {
    await boss.work('check-validity', async (job) => {
        logger.info('[ValidityWorker] Iniciando ronda diária de validade...');

        try {
            // ── 1. Busca itens que atingiram o 6º dia (janela de 24h) ──
            const seisDiasAtras = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString();
            const seteDiasAtras = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

            const { data: itensExpira, error: errItens } = await supabaseAdmin
                .from('catalogo_ativo')
                .select('loja_id, produto_nome')
                .eq('disponivel', true)
                .lt('atualizado_em', seisDiasAtras)
                .gte('atualizado_em', seteDiasAtras);

            if (errItens) {
                logger.error({ errItens }, '[ValidityWorker] Erro ao buscar itens');
                return;
            }

            if (!itensExpira || itensExpira.length === 0) {
                logger.info('[ValidityWorker] Nenhum item precisa de aviso hoje.');
                return;
            }

            // ── 2. Busca os dados das lojas envolvidas ──
            const lojaIds = [...new Set(itensExpira.map(i => i.loja_id))];
            const { data: lojasDados, error: errLojas } = await supabaseAdmin
                .from('lojas')
                .select('id, whatsapp, nome')
                .in('id', lojaIds)
                .eq('ativa', true);

            if (errLojas || !lojasDados) {
                logger.error({ errLojas }, '[ValidityWorker] Erro ao buscar dados das lojas');
                return;
            }

            // ── 3. Agrupa e Dispara ──
            const produtosPorLoja = new Map<string, string[]>();
            itensExpira.forEach(item => {
                const lista = produtosPorLoja.get(item.loja_id) || [];
                if (lista.length < 3) lista.push(item.produto_nome);
                produtosPorLoja.set(item.loja_id, lista);
            });

            for (const loja of lojasDados) {
                const exemplos = produtosPorLoja.get(loja.id) || [];
                if (exemplos.length === 0) continue;

                const listaStr = exemplos.join(', ');
                const aviso = `Olá, *${loja.nome}*! ⏳\n\nNossa auditoria notou que os preços de *${listaStr}* (e outros) estão quase vencendo o selo verde.\n\nQue tal revisá-los agora para manter a confiança dos seus clientes? É só digitar */revisar* para ver a lista completa!`;

                logger.info({ lojaId: loja.id }, '[ValidityWorker] Disparando aviso');
                await sendTextMessage(loja.whatsapp, aviso).catch(e => logger.error({ e }, 'Falha envio push'));
            }

            logger.info({ totalLojas: lojasDados.length }, '[ValidityWorker] Ronda finalizada com sucesso.');

        } catch (err) {
            logger.error({ err }, '[ValidityWorker] Erro crítico na execução do job');
        }
    });

    logger.info('[ValidityWorker] Worker de Validade registrado e aguardando jobs agendados');
}
