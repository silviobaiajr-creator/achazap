/**
 * notificationWorker.ts — Motor de Alertas Real-Time
 *
 * Arquitetura Event-Driven:
 *   1. O embeddingWorker envia o job 'checar-alertas' após processar novos produtos.
 *   2. Este worker busca consumidores com alertas ativos que correspondam aos produtos.
 *   3. Aplica a Regra de Ouro do Engajamento:
 *      - 1º disparo do dia: Envia o Template oficial (Cooldown de 24h respeitado).
 *      - 2º+ disparo do dia: Só envia SE o consumidor tiver respondido (janela aberta).
 */

import { boss } from '../queue/pgBossClient.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { sendTemplateMessage } from '../lib/whatsapp.js';
import { logger } from '../lib/logger.js';

const COOLDOWN_24H_MS = 24 * 60 * 60 * 1000;

interface AlertaJob {
    lojaId: string;
    produtos: Array<{
        id: string;
        produto_nome: string;
        membro_core: string | null;
        preco: number;
        unidade: string;
        cidade: string | null;
        bairro: string | null;
        estado: string | null;
        plano: string | null;
        loja_nome: string | null;
        loja_whatsapp: string | null;
    }>;
}

export async function startNotificationWorker() {
    await boss.work<AlertaJob>('checar-alertas', async (job) => {
        // pg-boss pode entregar job como array ou objeto dependendo da versão
        const jobData = (Array.isArray(job) ? job[0] : job) as { data: AlertaJob };
        const { lojaId, produtos } = jobData.data;

        if (!produtos || produtos.length === 0) return;

        logger.info({ lojaId, qtdProdutos: produtos.length }, '[NotifWorker] Verificando matches de alertas...');

        // ── 1. Busca todos alertas ativos de uma vez ──────────────────────────
        const { data: alertas, error } = await supabaseAdmin
            .from('consumidor_alertas')
            .select('id, whatsapp, tipo, termo, preco_alvo')
            .eq('ativo', true);

        if (error || !alertas || alertas.length === 0) {
            logger.info({ lojaId }, '[NotifWorker] Nenhum alerta ativo. Encerrando.');
            return;
        }

        // ── 2. Busca preferências dos consumidores com alertas ativos ─────────
        const whatsapps = [...new Set(alertas.map(a => a.whatsapp))];
        const { data: preferencias } = await supabaseAdmin
            .from('consumidor_preferencias')
            .select('whatsapp, cidade, bairro, estado, ultimo_envio, ultimo_engajamento')
            .in('whatsapp', whatsapps);

        const prefMap = new Map((preferencias || []).map(p => [p.whatsapp, p]));

        // ── 3. Agrupa matches por consumidor ──────────────────────────────────
        // { whatsapp → [{ produto, alerta }] }
        const matchesPorConsumidor = new Map<string, Array<{ produto: AlertaJob['produtos'][0]; alertaId: string }>>();

        for (const alerta of alertas) {
            const pref = prefMap.get(alerta.whatsapp);
            if (!pref) continue;

            for (const produto of produtos) {
                // Filtro geográfico: só avisa consumidores da mesma região do produto
                const mesmaRegiao =
                    !pref.cidade || !produto.cidade ||
                    pref.cidade.toLowerCase() === produto.cidade.toLowerCase() ||
                    pref.estado === produto.estado;
                if (!mesmaRegiao) continue;

                // Match semântico simples: verifica se o termo está no nome do produto
                const nomeProdutoNorm = produto.produto_nome.toLowerCase();
                const membroCore = (produto.membro_core || '').toLowerCase();
                const termoNorm = alerta.termo.toLowerCase();
                const matchNome = nomeProdutoNorm.includes(termoNorm) || membroCore.includes(termoNorm);
                if (!matchNome) continue;

                // Filtro de preço para alertas "sniper"
                if (alerta.tipo === 'sniper_preco' && alerta.preco_alvo !== null) {
                    if (produto.preco > alerta.preco_alvo) continue;
                }

                // Match encontrado — agrupa para disparar 1 única mensagem por consumidor
                if (!matchesPorConsumidor.has(alerta.whatsapp)) {
                    matchesPorConsumidor.set(alerta.whatsapp, []);
                }
                matchesPorConsumidor.get(alerta.whatsapp)!.push({ produto, alertaId: alerta.id });
            }
        }

        if (matchesPorConsumidor.size === 0) {
            logger.info({ lojaId }, '[NotifWorker] Nenhum match encontrado.');
            return;
        }

        logger.info({ lojaId, qtdConsumidores: matchesPorConsumidor.size }, '[NotifWorker] Matches encontrados. Disparando alertas...');

        // ── 4. Regra de Ouro do Engajamento + Disparo ────────────────────────
        const agora = new Date();

        for (const [whatsapp, matches] of matchesPorConsumidor) {
            const pref = prefMap.get(whatsapp)!;
            const ultimoEnvio = pref.ultimo_envio ? new Date(pref.ultimo_envio) : null;
            const ultimoEngajamento = pref.ultimo_engajamento ? new Date(pref.ultimo_engajamento) : null;

            const dentroDosCooldown24h = ultimoEnvio && (agora.getTime() - ultimoEnvio.getTime()) < COOLDOWN_24H_MS;

            if (dentroDosCooldown24h) {
                // Já foi enviado um Template hoje — só dispara 2º alerta se o usuário tiver respondido
                const usuarioEngajou = ultimoEngajamento && ultimoEnvio && ultimoEngajamento > ultimoEnvio;
                if (!usuarioEngajou) {
                    logger.info({ whatsapp: whatsapp.slice(-4), lojaId }, '[NotifWorker] Cooldown ativo e sem engajamento — silenciando 2º alerta.');
                    continue;
                }
                // Usuário respondeu → janela aberta → pode enviar sem custo extra de template
                // Neste caso enviamos como mensagem de texto livre (dentro da janela da Meta)
                await enviarAlertaJanelaAberta(whatsapp, matches.map(m => m.produto));
            } else {
                // 1º disparo do dia: Envia Template oficial da Meta
                await enviarAlertaTemplate(whatsapp, matches.map(m => m.produto));
            }

            // Atualiza o ultimo_envio no banco
            await supabaseAdmin
                .from('consumidor_preferencias')
                .update({ ultimo_envio: agora.toISOString() })
                .eq('whatsapp', whatsapp);

            // Desativa os alertas que foram notificados (evita reenvio no próximo job)
            const alertaIds = matches.map(m => m.alertaId);
            await supabaseAdmin
                .from('consumidor_alertas')
                .update({ ativo: false })
                .in('id', alertaIds);
        }

        logger.info({ lojaId }, '[NotifWorker] Ciclo de alertas concluído.');
    });
}

// ─── Template Oficial (1º disparo — fora da janela de 24h) ────────────────────
async function enviarAlertaTemplate(
    whatsapp: string,
    produtos: AlertaJob['produtos']
) {
    // Monta o corpo com até 3 produtos para não extrapolar o limite do template
    const top3 = produtos.slice(0, 3);
    const listaOfertas = top3
        .map(p => {
            if (p.plano === 'premium') {
                return `⭐ *${p.produto_nome}* — R$ ${p.preco.toFixed(2).replace('.', ',')} na loja *${p.loja_nome}* (Zap: ${p.loja_whatsapp})`;
            }
            return `• *${p.produto_nome}* — R$ ${p.preco.toFixed(2).replace('.', ',')} / ${p.unidade}`;
        })
        .join(' | ');

    const totalExtra = produtos.length - top3.length;
    const rodape = totalExtra > 0
        ? ` ...e mais ${totalExtra} oferta(s) disponíveis!`
        : '';

    // Template: alerta_oferta_sniper
    // Variável {{1}}: Lista de produtos
    // Template deve ser cadastrado no Facebook Business Manager com esse corpo:
    //   "🔔 Seu Radar AchaZap encontrou ofertas que você pediu!\n\n{{1}}{{2}}\n\n💡 Outras lojas podem postar preços melhores hoje. Responda 'Quero ver mais' para continuar recebendo!"
    await sendTemplateMessage(
        whatsapp,
        'alerta_oferta_sniper',
        [listaOfertas, rodape],
        []
    );

    logger.info({ whatsapp: whatsapp.slice(-4), qtd: top3.length }, '[NotifWorker] Template disparado.');
}

// ─── Mensagem Livre (2º disparo — dentro da janela de 24h, após engajamento) ──
async function enviarAlertaJanelaAberta(
    whatsapp: string,
    produtos: AlertaJob['produtos']
) {
    const { sendTextMessage } = await import('../lib/whatsapp.js');
    const top3 = produtos.slice(0, 3);
    const listaOfertas = top3
        .map(p => {
            if (p.plano === 'premium') {
                return `⭐ *${p.produto_nome}* — R$ ${p.preco.toFixed(2).replace('.', ',')} na loja *${p.loja_nome}*\n📲 Zap da loja: ${p.loja_whatsapp}`;
            }
            return `• *${p.produto_nome}* — R$ ${p.preco.toFixed(2).replace('.', ',')} / ${p.unidade}`;
        })
        .join('\n\n');

    await sendTextMessage(
        whatsapp,
        `🔔 Nova oferta chegou!\n\n${listaOfertas}\n\n_Quer ver onde encontrar? Me mande o nome do produto!_`
    );

    logger.info({ whatsapp: whatsapp.slice(-4), qtd: top3.length }, '[NotifWorker] Mensagem livre disparada (janela aberta).');
}
