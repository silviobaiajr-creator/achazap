import { Worker, Job } from 'bullmq';
import { createClient } from '../queue/redisClient.js';
import { processMessage } from '../ai/orchestrator.js';
import type { WhatsAppMessage } from '../lib/whatsapp.js';

const connection = createClient();


/**
 * Worker responsável por processar as mensagens da fila "messages".
 * Ele chama o orquestrador de IA (Gemini) para cada nova mensagem.
 */
export const messageWorker = new Worker<WhatsAppMessage>(
    'messages',
    async (job: Job<WhatsAppMessage>) => {
        console.log(`[Processor] Iniciando processamento do job ${job.id} de ${job.data.from}`);
        await processMessage(job.data);
    },
    {
        connection,
        concurrency: 5,        // Processa até 5 mensagens simultâneas
        limiter: {
            max: 10,
            duration: 1000,    // Limite de 10 mensagens por segundo (respeitando API do Gemini)
        },
    }
);

// Monitoramento de eventos do Worker
messageWorker.on('failed', (job, err) => {
    console.error(`[Processor] ❌ Job ${job?.id} falhou:`, err.message);
});

messageWorker.on('completed', (job) => {
    console.log(`[Processor] ✅ Job ${job.id} concluído com sucesso para ${job.data.from}`);
});

messageWorker.on('active', (job) => {
    console.log(`[Processor] ⚡ Job ${job.id} agora está ATIVO`);
});
