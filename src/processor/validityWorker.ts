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
            // ── 1. Busca lojas com produtos entrando no 6º dia de "vencimento" ──
            // Intervalo: entre 6 e 7 dias atrás
            const { data: lojasAvisar, error } = await supabaseAdmin
                .from('catalogo_ativo')
                .select(`
                    loja_id,
                    produto_nome,
                    lojas:lojas!inner (
                        whatsapp,
                        nome
                    )
                `)
                .eq('disponivel', true)
                .lt('updated_at', new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString())
                .gte('updated_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());

            if (error) {
                logger.error({ error }, '[ValidityWorker] Erro ao buscar itens para aviso');
                return;
            }

            if (!lojasAvisar || lojasAvisar.length === 0) {
                logger.info('[ValidityWorker] Nenhum lojista precisa de aviso hoje.');
                return;
            }

            // ── 2. Agrupa por loja para não enviar múltiplas mensagens ──
            const agrupamento = new Map<string, { whatsapp: string; nomeLoja: string; produtos: string[] }>();

            for (const item of lojasAvisar) {
                const lojaInfo = item.lojas as any;
                if (!agrupamento.has(item.loja_id)) {
                    agrupamento.set(item.loja_id, {
                        whatsapp: lojaInfo.whatsapp,
                        nomeLoja: lojaInfo.nome,
                        produtos: []
                    });
                }
                const lojaData = agrupamento.get(item.loja_id)!;
                if (lojaData.produtos.length < 3) {
                    lojaData.produtos.push(item.produto_nome);
                }
            }

            // ── 3. Dispara as mensagens proativas ──
            for (const [lojaId, data] of agrupamento.entries()) {
                const listaProdutos = data.produtos.join(', ');
                const aviso = `Olá, *${data.nomeLoja}*! ⏳\n\nNossa auditoria notou que os preços de *${listaProdutos}* (e outros) estão quase vencendo o selo verde.\n\nQue tal revisá-los agora para manter a confiança dos seus clientes? É só digitar */revisar* para ver a lista completa!`;

                logger.info({ lojaId, whatsapp: data.whatsapp }, '[ValidityWorker] Enviando aviso proativo');
                
                try {
                    await sendTextMessage(data.whatsapp, aviso);
                } catch (sendErr) {
                    logger.error({ sendErr, lojaId }, '[ValidityWorker] Falha ao enviar mensagem para loja');
                }
            }

            logger.info({ totalLojas: agrupamento.size }, '[ValidityWorker] Ronda finalizada com sucesso.');

        } catch (err) {
            logger.error({ err }, '[ValidityWorker] Erro crítico na execução do job');
        }
    });

    logger.info('[ValidityWorker] Worker de Validade registrado e aguardando jobs agendados');
}
