import { processMessage } from '../ai/orchestrator.js';
import type { WhatsAppMessage } from '../lib/whatsapp.js';
import { logger } from '../lib/logger.js';
import { boss } from '../queue/pgBossClient.js';

/**
 * Inicializador da rotina que desempilha mensagens do banco.
 * O pg-boss cuida do limite de concorrência e das re-tentativas baseadas no timeout.
 */
export async function startMessageWorker() {
    await boss.work('messages', {
        teamSize: 5,        // Equivalente ao concurrency: 5
        teamConcurrency: 5,
    } as any, async (jobs: any) => { // boss.work em lote ou unico
        const job = Array.isArray(jobs) ? jobs[0] : (jobs as any);
        const message = job.data;
        const msgId = job.id;
        
        logger.info({ jobId: msgId, from: message.from, type: message.type }, '[Processor] Iniciando job (pg-boss)');
        await processMessage(message);
    });
    logger.info('[Processor] Worker ativo com pg-boss');
}
