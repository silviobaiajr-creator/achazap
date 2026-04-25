import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'crypto';
import type { FastifyInstance } from 'fastify';

// Configurando as variáveis de ambiente necessárias ANTES das importações
const TEST_SECRET = 'test_secret_123';
process.env.BASE_URL = 'http://localhost:3000';
process.env.WHATSAPP_APP_SECRET = TEST_SECRET;
process.env.NODE_ENV = 'test';

function generatePayload(wamid: string) {
    return {
        object: 'whatsapp_business_account',
        entry: [{
            id: '1234567890',
            changes: [{
                field: 'messages',
                value: {
                    messaging_product: 'whatsapp',
                    metadata: { display_phone_number: '1234', phone_number_id: '5678' },
                    contacts: [{ profile: { name: 'Load Tester' }, wa_id: '5511999999999' }],
                    messages: [{
                        from: '5511999999999',
                        id: wamid,
                        timestamp: Math.floor(Date.now() / 1000).toString(),
                        type: 'text',
                        text: { body: 'Load test message' }
                    }]
                }
            }]
        }]
    };
}

function generateSignature(payload: any, secret: string): string {
    const rawBody = Buffer.from(JSON.stringify(payload));
    return 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
}

describe('Webhook Stress Test - Pool Exhaustion', () => {
    let app: FastifyInstance;
    let pool: any;
    let boss: any;

    beforeAll(async () => {
        const serverModule = await import('../../server.js');
        const dbModule = await import('../../lib/db.js');
        const bossModule = await import('../../queue/pgBossClient.js');

        app = serverModule.buildServer();
        pool = dbModule.pool;
        boss = bossModule.boss;

        // É CRUCIAL iniciar o boss manualmente no teste se o server não rodar o start() completo
        try { await boss.start(); } catch {}
        
        await app.ready();
    });

    afterAll(async () => {
        await app.close();
        
        try {
            await boss.stop();
        } catch { /* ignora */ }
        
        await pool.end();
    });

    it('deve conseguir enfileirar 50 requisições simultâneas sem estourar o pool', async () => {
        const TOTAL_REQUESTS = 50;
        console.log(`\n🚀 [WEBHOOK STRESS TEST] Disparando ${TOTAL_REQUESTS} requests paralelos...`);
        
        const startTime = Date.now();
        const promises = [];

        for (let i = 0; i < TOTAL_REQUESTS; i++) {
            const wamid = `wamid.TEST.${Date.now()}.${i}`;
            const payload = generatePayload(wamid);
            const signature = generateSignature(payload, TEST_SECRET);

            promises.push(
                app.inject({
                    method: 'POST',
                    url: '/webhook',
                    headers: {
                        'content-type': 'application/json',
                        'x-hub-signature-256': signature
                    },
                    payload: payload
                })
            );
        }

        const responses = await Promise.allSettled(promises);
        const duration = Date.now() - startTime;
        
        let successful = 0;
        let failed = 0;
        const errors = new Map<string, number>();

        responses.forEach(res => {
            if (res.status === 'fulfilled') {
                if (res.value.statusCode === 200) {
                    successful++;
                } else {
                    failed++;
                    const msg = `HTTP ${res.value.statusCode}: ${res.value.payload}`;
                    errors.set(msg, (errors.get(msg) || 0) + 1);
                }
            } else {
                failed++;
                const msg = res.reason?.message || 'Error Desconhecido';
                errors.set(msg, (errors.get(msg) || 0) + 1);
            }
        });

        console.log(`\n✅ Sucesso: ${successful}/${TOTAL_REQUESTS}`);
        console.log(`❌ Falhas: ${failed}/${TOTAL_REQUESTS}`);
        console.log(`⏱️ Tempo total: ${duration}ms (${(TOTAL_REQUESTS / (duration / 1000)).toFixed(2)} req/s)\n`);

        if (failed > 0) {
            console.log('⚠️ Erros reportados:');
            errors.forEach((count, err) => console.log(`   - ${count}x: ${err}`));
        }

        expect(successful).toBe(TOTAL_REQUESTS);
        expect(failed).toBe(0);
    }, 60000);
});
