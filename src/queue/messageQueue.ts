import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { processMessage } from '../ai/orchestrator.js';
import type { WhatsAppMessage } from '../lib/whatsapp.js';

const connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
});

// Fila principal de mensagens recebidas
export const messageQueue = new Queue<WhatsAppMessage>('messages', { connection });

// Worker que processa cada mensagem em background
export const messageWorker = new Worker<WhatsAppMessage>(
    'messages',
    async (job: Job<WhatsAppMessage>) => {
        await processMessage(job.data);
    },
    {
        connection,
        concurrency: 5,        // até 5 mensagens simultâneas
        limiter: {
            max: 10,
            duration: 1000,      // máx 10 jobs/s para não sobrecarregar Gemini
        },
    }
);

messageWorker.on('failed', (job, err) => {
    console.error(`[Queue] Job ${job?.id} falhou:`, err.message);
});

messageWorker.on('completed', (job) => {
    console.log(`[Queue] Job ${job.id} concluído para ${job.data.from}`);
});
