import 'dotenv/config';
import { buildServer } from './server.js';
import { messageWorker } from './processor/messageProcessor.js';

const PORT = Number(process.env.PORT ?? 3000);

async function main() {
    const app = buildServer();

    try {
        await app.listen({ port: PORT, host: '0.0.0.0' });
        console.log(`✅ AchaZap rodando na porta ${PORT}`);
        console.log(`📡 Webhook: http://localhost:${PORT}/webhook`);
        console.log(`🔗 Redirect: http://localhost:${PORT}/r`);
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }

    // Graceful shutdown
    const shutdown = async () => {
        console.log('\n⚠️  Encerrando servidor...');
        await messageWorker.close();
        await app.close();
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main();
