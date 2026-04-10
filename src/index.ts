import 'dotenv/config';
import './config.js';
import { buildServer } from './server.js';
import { startMessageWorker } from './processor/messageProcessor.js';
import { startQueue, boss } from './queue/pgBossClient.js';

const PORT = Number(process.env.PORT ?? 3000);

async function main() {
    const app = buildServer();

    try {
        await startQueue();
        await startMessageWorker();
        
        await app.listen({ port: PORT, host: '0.0.0.0' });
        const publicUrl = process.env.BASE_URL ?? `http://localhost:${PORT}`;
        console.log(`✅ AchaZap rodando na porta ${PORT}`);
        console.log(`📡 Webhook: ${publicUrl}/webhook`);
        console.log(`🔗 Redirect: ${publicUrl}/r`);
    } catch (err) {
        app.log.error(err);
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
}

main();
