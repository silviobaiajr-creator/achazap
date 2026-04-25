/**
 * scripts/stress-render.ts
 * Script para teste de carga externo contra o servidor do AchaZap (Render ou Local).
 * 
 * Uso: npx tsx scripts/stress-render.ts <URL_WEBHOOK> <QTD_MENSAGENS>
 * Ex:  npx tsx scripts/stress-render.ts https://achazap.onrender.com/webhook 50
 */

import 'dotenv/config';
import { createHmac } from 'node:crypto';

const url = process.argv[2];
const count = parseInt(process.argv[3] || '20', 10);
const secret = process.env.WHATSAPP_APP_SECRET;

if (!url) {
    console.error('❌ Erro: URL do webhook não fornecida.');
    console.log('Uso: npx tsx scripts/stress-render.ts <URL_WEBHOOK> [QTD]');
    process.exit(1);
}

if (!secret) {
    console.error('❌ Erro: WHATSAPP_APP_SECRET não encontrado no .env');
    process.exit(1);
}

function generatePayload(i: number) {
    const wamid = `wamid.STRESS.${Date.now()}.${i}`;
    return {
        object: 'whatsapp_business_account',
        entry: [{
            id: '1234567890',
            changes: [{
                field: 'messages',
                value: {
                    messaging_product: 'whatsapp',
                    metadata: { display_phone_number: '5511999999999', phone_number_id: '12345' },
                    contacts: [{ profile: { name: 'Stress Tester' }, wa_id: '5511999999999' }],
                    messages: [{
                        from: '5511999999999',
                        id: wamid,
                        timestamp: Math.floor(Date.now() / 1000).toString(),
                        type: 'text',
                        text: { body: `Mensagem de Teste de Carga #${i}` }
                    }]
                }
            }]
        }]
    };
}

function generateSignature(payload: any, secret: string): string {
    const rawBody = JSON.stringify(payload);
    return 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
}

async function run() {
    console.log(`\n🚀 Iniciando teste de carga...`);
    console.log(`📍 Alvo: ${url}`);
    console.log(`📦 Mensagens: ${count}\n`);

    const startTime = Date.now();
    const promises = [];

    for (let i = 1; i <= count; i++) {
        const payload = generatePayload(i);
        const signature = generateSignature(payload, secret!);

        promises.push(
            fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Hub-Signature-256': signature,
                    'User-Agent': 'AchaZap-Stress-Tester/1.0'
                },
                body: JSON.stringify(payload)
            }).then(async r => ({
                status: r.status,
                text: await r.text()
            })).catch(err => ({
                status: 500,
                text: err.message
            }))
        );
    }

    const results = await Promise.all(promises);
    const duration = Date.now() - startTime;

    let success = 0;
    let failed = 0;

    results.forEach((res, i) => {
        if (res.status === 200) {
            success++;
        } else {
            failed++;
            console.error(`  ❌ Falha na msg #${i+1}: HTTP ${res.status} - ${res.text}`);
        }
    });

    console.log(`\n🏁 Teste Finalizado!`);
    console.log(`✅ Sucessos: ${success}/${count}`);
    console.log(`❌ Falhas: ${failed}/${count}`);
    console.log(`⏱️ Tempo Total: ${duration}ms`);
    console.log(`⚡ Média: ${(count / (duration / 1000)).toFixed(2)} req/s\n`);

    if (success === count) {
        console.log('🎉 O servidor aguentou o tranco com 100% de sucesso!');
    }
}

run();
