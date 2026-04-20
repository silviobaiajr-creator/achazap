import 'dotenv/config';
import './config.js';
import { buildServer } from './server.js';
import { startMessageWorker } from './processor/messageProcessor.js';
import { startValidityWorker } from './processor/validityWorker.js';
import { startAnalysisWorker } from './processor/analysisWorker.js';
import { startQueue, boss } from './queue/pgBossClient.js';

const PORT = Number(process.env.PORT ?? 3000);

async function main() {
    const app = buildServer();

    try {
        await startQueue();
        
        // Inicializa workers de forma independente para que um não trave o outro
        try {
            await startMessageWorker();
            console.log('✅ Worker de Mensagens (WhatsApp) ativo');
        } catch (err) {
            console.error('❌ Falha ao iniciar worker de mensagens:', err);
        }

        try {
            await startValidityWorker();
            console.log('✅ Worker de Validade (Cron 9h) ativo');
        } catch (err) {
            console.error('❌ Falha ao iniciar worker de validade:', err);
        }

        try {
            await startAnalysisWorker();
            console.log('✅ Worker Analytics Insights (Cron Segunda 9h) ativo');
        } catch (err) {
            console.error('❌ Falha ao iniciar worker Analytics:', err);
        }
        
        await app.listen({ port: PORT, host: '0.0.0.0' });
        const publicUrl = process.env.BASE_URL ?? `http://localhost:${PORT}`;
        console.log(`✅ AchaZap rodando na porta ${PORT}`);
        console.log(`📡 Webhook: ${publicUrl}/webhook`);
        console.log(`🔗 Redirect: ${publicUrl}/r`);
    } catch (err) {
        console.error('🔥 Erro fatal no startup:', err);
        process.exit(1);
    }

    // Graceful Shutdown completo: fecha Fastify e pg-boss
    const shutdown = async () => {
        console.log('\n⚠️  Encerrando servidor graciosamente...');
        try {
            await boss.stop();
            console.log('   ✅ Pg-boss Worker encerrado');
            await app.close();
            console.log('   ✅ Fastify encerrado');
        } catch (err) {
            console.error('   ⚠️ Erro no shutdown:', err);
        }
        process.exit(0);
    };

    process.on('SIGINT',  shutdown);
    process.on('SIGTERM', shutdown);

    // ── GATILHOS GLOBAIS DE MONITORAMENTO — Sprint 11 #3 ──
    process.on('uncaughtException', async (err) => {
        await logErroCritico({
            origem: 'GLOBAL',
            mensagem: `🔥 Crash Crítico (Uncaught): ${err.message}`,
            err
        });
        process.exit(1);
    });

    process.on('unhandledRejection', async (reason) => {
        await logErroCritico({
            origem: 'GLOBAL',
            mensagem: `🔥 Promessa Rejeitada: ${String(reason)}`,
            err: reason
        });
    });
}

import { logErroCritico } from './lib/monitor.js';
main();
