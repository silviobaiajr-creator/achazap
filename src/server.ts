import 'dotenv/config';
import './config.js';
import Fastify from 'fastify';
import { createHmac, timingSafeEqual } from 'crypto';
import { extractMessage } from './lib/whatsapp.js';
import { supabaseAdmin as supabase } from './lib/supabase.js';
import { verificarConexao, marcarWamidProcessado } from './lib/redis-cloud.js';
import { messageQueue } from './queue/messageQueue.js';
import { logger } from './lib/logger.js';

const VERIFY_TOKEN  = process.env.WHATSAPP_VERIFY_TOKEN!;
const APP_SECRET    = process.env.WHATSAPP_APP_SECRET;

// 🛡️ REMEDIAÇÃO A10 (Fail-Closed): O servidor JAMAIS deve subir sem os tokens de assinatura.
if (!VERIFY_TOKEN || !APP_SECRET) {
    throw new Error('🛡️ SECURITY HALT: Variáveis de ambiente WHATSAPP_VERIFY_TOKEN e WHATSAPP_APP_SECRET ausentes. Servidor rejeitou inicialização.');
}

export function buildServer() {
    const app = Fastify({
        logger: true,
        // Preserva o body bruto para validação HMAC correta
        bodyLimit: 5 * 1024 * 1024, // 5 MB máx
    });

    // Plugin para expor rawBody
    app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
        try {
            const parsed = JSON.parse(body.toString());
            (parsed as any).__rawBody = body; // carrega o buffer original junto
            done(null, parsed);
        } catch (err: any) {
            done(err, undefined);
        }
    });

    // ============================================================
    // GET /webhook — Handshake de verificação da Meta
    // ============================================================
    app.get<{
        Querystring: { 'hub.mode': string; 'hub.verify_token': string; 'hub.challenge': string };
    }>('/webhook', async (request, reply) => {
        const mode      = request.query['hub.mode'];
        const token     = typeof request.query['hub.verify_token'] === 'string' ? request.query['hub.verify_token'] : '';
        const challenge = request.query['hub.challenge'];

        try {
            const incomingTokenBuf = Buffer.from(token);
            const expectedTokenBuf = Buffer.from(VERIFY_TOKEN);
            
            if (mode === 'subscribe' && 
                incomingTokenBuf.length === expectedTokenBuf.length && 
                timingSafeEqual(incomingTokenBuf, expectedTokenBuf)) {
                app.log.info('[Webhook] Verificação da Meta concluída ✅');
                return reply.status(200).send(challenge);
            }
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        } catch (e) {
             // Ignora erro de buffer mapping em lixo enviado.
        }
        
        return reply.status(403).send({ error: 'Token/Acesso inválido' });
    });

    // ============================================================
    // POST /webhook — Recebe mensagens do WhatsApp
    // ============================================================
    app.post('/webhook', async (request, reply) => {
        const body = request.body as any;

        // ── CAMADA 1: Validação HMAC sobre raw body ──
        // APP_SECRET foi forçado na inicialização, se chegou aqui, ele existe.
        const rawBody = Buffer.isBuffer(body.__rawBody)
            ? body.__rawBody
            : Buffer.from(JSON.stringify(body));

        const signature = (request.headers['x-hub-signature-256'] as string) ?? '';
        const expected  = 'sha256=' + createHmac('sha256', APP_SECRET!)
            .update(rawBody)
            .digest('hex');

        try {
            const sigBuf = Buffer.from(signature);
            const expBuf = Buffer.from(expected);
            if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
                app.log.warn('[Webhook] Assinatura HMAC inválida — interceptação bloqueada');
                return reply.status(401).send({ error: 'Assinatura inválida' });
            }
        } catch {
            return reply.status(401).send({ error: 'Assinatura inválida' });
        }

        // ── CAMADA 2: Morte Síncrona — responde 200 para Meta imediatamente ──
        reply.status(200).send({ status: 'ok' });

        // ── CAMADA 3: Tratamento de exceção unhandled assíncrono (A10) ──
        setImmediate(async () => {
            try {
                const msg = extractMessage(body);
                if (!msg) {
                    // Evento de sistema, echo, leitura, ou tipo não suportado — descartar silenciosamente
                    app.log.debug({ entry: body }, '[Webhook] Payload ignorado (sem mensagem válida)');
                    return;
                }

                // Extrai o wamid do payload bruto para checar duplicatas
                const wamid: string | undefined = (body as any)
                    ?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.id;

                if (wamid) {
                    const jáProcessado = await marcarWamidProcessado(wamid);
                    if (jáProcessado) {
                        app.log.info(`[Webhook] Mensagem duplicada ignorada (wamid: ${wamid})`);
                        return;
                    }
                }

                // ── CAMADA 4: Ignorar reactions explicitamente (Sprint 1 #2) ──
                if (msg.type === 'reaction') {
                    app.log.info(`[Webhook] Reaction ignorado de ${msg.from}`);
                    return;
                }

                // ── CAMADA 5: Enfileirar via BullMQ (3.1 — persistência e retry) ──
                logger.info({ from: msg.from, type: msg.type, wamid }, '[Webhook] Mensagem enfileirada');
                await messageQueue.add('process', msg, {
                    jobId:   wamid || `${msg.from}_${msg.timestamp}`,  // idempotência no BullMQ também
                    attempts: 2,
                    backoff:  { type: 'exponential', delay: 2000 },
                    removeOnComplete: 200,
                    removeOnFail:    500,
                });
            } catch (err) {
                // Previne queda do processo por Unhandled Promise Rejection
                logger.error({ err }, '🛡️ SECURITY/CRASH PREVENTED: Falha severa no enfileiramento pós-webhook.');
            }
        });
    });

    // ============================================================
    // GET /r — Redirect de cliques (debita saldo da loja)
    // ============================================================
    app.get<{ Querystring: { token: string } }>('/r', async (request, reply) => {
        const query = request.query as any;
        const token = query.token;
        
        // 🛡️ REMEDIAÇÃO A05: Typosquatting / Type Confusion Injection
        if (!token || typeof token !== 'string') {
             return reply.status(400).send({ error: 'Comportamento anômalo detectado (Token malformado)' });
        }

        try {
            const { data: registro, error } = await supabase
                .from('cliques_consumidos')
                .select('id, loja_id, usuario_id, produto_ref, debitado, link_gerado, consumido_em')
                .eq('link_token', token)
                .single();

            if (error || !registro) return reply.status(404).send({ error: 'Link inválido ou expirado' });

            // Idempotência: se já debitou, apenas redireciona
            if (registro.debitado) return reply.redirect(registro.link_gerado, 302);

            // Deduplicação: mesmo user + loja + produto na última hora
            const umaHoraAtras = new Date(Date.now() - 60 * 60 * 1000).toISOString();
            const { count } = await supabase
                .from('cliques_consumidos')
                .select('id', { count: 'exact', head: true })
                .eq('usuario_id', registro.usuario_id)
                .eq('loja_id', registro.loja_id)
                .eq('produto_ref', registro.produto_ref)
                .eq('debitado', true)
                .gte('consumido_em', umaHoraAtras);

            const jaDebitadoRecentemente = (count ?? 0) > 0;

            await supabase
                .from('cliques_consumidos')
                .update({
                    debitado: !jaDebitadoRecentemente,
                    motivo_skip: jaDebitadoRecentemente ? 'deduplicacao' : null,
                })
                .eq('id', registro.id);

            return reply.redirect(registro.link_gerado, 302);
            
        } catch (dbError) {
             logger.error({ err: dbError }, 'Falha de banco no redirecting.');
             return reply.status(500).send({ error: 'Falha interna' });
        }
    });

    // ============================================================
    // GET /health — Health check
    // ============================================================
    app.get('/health', async () => {
        const redisOk = await verificarConexao();
        return { status: 'ok', ts: new Date().toISOString(), redis: redisOk ? 'ok' : 'error' };
    });

    return app;
}
