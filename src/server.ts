import 'dotenv/config';
import Fastify from 'fastify';
import { createHmac } from 'crypto';
import { messageQueue } from '../queue/messageQueue.js';
import { extractMessage } from '../lib/whatsapp.js';
import { supabase } from '../lib/supabase.js';

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN!;
const APP_SECRET = process.env.WHATSAPP_APP_SECRET ?? '';  // para validação HMAC

export function buildServer() {
    const app = Fastify({ logger: true });

    // ============================================================
    // GET /webhook — Handshake de verificação da Meta
    // ============================================================
    app.get<{
        Querystring: { 'hub.mode': string; 'hub.verify_token': string; 'hub.challenge': string };
    }>('/webhook', async (request, reply) => {
        const mode = request.query['hub.mode'];
        const token = request.query['hub.verify_token'];
        const challenge = request.query['hub.challenge'];

        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            app.log.info('[Webhook] Verificação da Meta concluída ✅');
            return reply.status(200).send(challenge);
        }

        return reply.status(403).send({ error: 'Token inválido' });
    });

    // ============================================================
    // POST /webhook — Recebe mensagens do WhatsApp
    // ============================================================
    app.post('/webhook', {
        config: { rawBody: true },   // necessário para validar assinatura HMAC
    }, async (request, reply) => {
        // Valida assinatura HMAC (segurança — confirma que veio da Meta)
        if (APP_SECRET) {
            const signature = (request.headers['x-hub-signature-256'] as string) ?? '';
            const expected = 'sha256=' + createHmac('sha256', APP_SECRET)
                .update(JSON.stringify(request.body))
                .digest('hex');

            if (signature !== expected) {
                app.log.warn('[Webhook] Assinatura HMAC inválida — requisição rejeitada');
                return reply.status(401).send({ error: 'Assinatura inválida' });
            }
        }

        // Responde 200 imediatamente (Meta exige resposta em < 5s)
        reply.status(200).send({ status: 'ok' });

        // Extrai a mensagem e enfileira para processamento assíncrono
        const msg = extractMessage(request.body);
        if (msg) {
            await messageQueue.add('process', msg, {
                attempts: 3,
                backoff: { type: 'exponential', delay: 2000 },
            });
            app.log.info(`[Webhook] Mensagem de ${msg.from} enfileirada`);
        }
    });

    // ============================================================
    // GET /r — Endpoint de redirect de cliques
    // Debita 1 clique da loja e redireciona para o WhatsApp
    // ============================================================
    app.get<{ Querystring: { token: string; wa: string } }>('/r', async (request, reply) => {
        const { token, wa } = request.query;

        if (!token || !wa) {
            return reply.status(400).send({ error: 'Parâmetros inválidos' });
        }

        // Busca o registro pendente no banco
        const { data: registro, error } = await supabase
            .from('cliques_consumidos')
            .select('id, loja_id, usuario_id, produto_ref, debitado, consumido_em')
            .eq('link_token', token)
            .single();

        if (error || !registro) {
            return reply.status(404).send({ error: 'Link inválido ou expirado' });
        }

        // Deduplicação: mesmo user + loja + produto nas últimas 1 hora
        const umaHoraAtras = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const { count } = await supabase
            .from('cliques_consumidos')
            .select('id', { count: 'exact', head: true })
            .eq('usuario_id', registro.usuario_id)
            .eq('loja_id', registro.loja_id)
            .eq('produto_ref', registro.produto_ref)
            .eq('debitado', true)
            .gte('consumido_em', umaHoraAtras);

        const jaDebitado = (count ?? 0) > 0;

        // Atualiza o registro para marcar como debitado (ou skip)
        await supabase
            .from('cliques_consumidos')
            .update({
                debitado: !jaDebitado,
                motivo_skip: jaDebitado ? 'deduplicacao' : null,
            })
            .eq('id', registro.id);

        // Redireciona para o WhatsApp da loja
        return reply.redirect(decodeURIComponent(wa), 302);
    });

    // ============================================================
    // GET /health — Health check
    // ============================================================
    app.get('/health', async () => ({ status: 'ok', ts: new Date().toISOString() }));

    return app;
}
