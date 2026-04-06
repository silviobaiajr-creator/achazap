import 'dotenv/config';
import './config.js';
import { buildServer } from './server.js';
import { messageWorker } from './processor/messageProcessor.js'; // inicia o Worker BullMQ

const PORT = Number(process.env.PORT ?? 3000);

async function main() {
    const app = buildServer();

    try {
        await app.listen({ port: PORT, host: '0.0.0.0' });
        const publicUrl = process.env.BASE_URL ?? `http://localhost:${PORT}`;
        console.log(`✅ AchaZap rodando na porta ${PORT}`);
        console.log(`📡 Webhook: ${publicUrl}/webhook`);
        console.log(`🔗 Redirect: ${publicUrl}/r`);
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }

    // Graceful Shutdown completo: fecha Fastify, Worker BullMQ e Redis
    const shutdown = async () => {
        console.log('\n⚠️  Encerrando servidor graciosamente...');
        try {
            await messageWorker.close();          // para de aceitar novos jobs
            console.log('   ✅ BullMQ Worker encerrado');

            await app.close();
            console.log('   ✅ Fastify encerrado');

            const { getRedisCloudClient } = await import('./lib/redis-cloud.js');
            getRedisCloudClient().disconnect();
            console.log('   ✅ Redis desconectado');
        } catch (err) {
            console.error('   ⚠️ Erro no shutdown:', err);
        }
        process.exit(0);
    };

    process.on('SIGINT',  shutdown);
    process.on('SIGTERM', shutdown);
}

main();
