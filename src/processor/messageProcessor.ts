import { Worker, Job } from 'bullmq';
import { createClient } from '../queue/redisClient.js';
import { processMessage } from '../ai/orchestrator.js';
import type { WhatsAppMessage } from '../lib/whatsapp.js';
import { logger } from '../lib/logger.js';

const connection = createClient();

/**
 * Worker responsável por processar as mensagens da fila "messages".
 * Chama o orquestrador de IA (Gemini) para cada nova mensagem.
 * concurrency: 5 → até 5 conversas simultâneas
 * limiter: 10/s → respeita rate limit da API Gemini
 */
export const messageWorker = new Worker<WhatsAppMessage>(
    'messages',
    async (job: Job<WhatsAppMessage>) => {
        logger.info({ jobId: job.id, from: job.data.from, type: job.data.type }, '[Processor] Iniciando job');
        await processMessage(job.data);
    },
    {
        connection,
        concurrency: 5,
        limiter: {
            max: 10,
            duration: 1000,
        },
    }
);

messageWorker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, from: job?.data?.from, err: err.message }, '[Processor] Job falhou');
});

messageWorker.on('completed', (job) => {
    logger.info({ jobId: job.id, from: job.data.from }, '[Processor] Job concluído');
});

messageWorker.on('active', (job) => {
    logger.debug({ jobId: job.id, from: job.data.from }, '[Processor] Job ativo');
});
