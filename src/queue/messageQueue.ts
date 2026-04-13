import type { WhatsAppMessage } from '../lib/whatsapp.js';
import { boss } from './pgBossClient.js';

export const messageQueue = {
    add: async (name: string, data: WhatsAppMessage, opts?: any) => {
        // Envia para o pg-boss mantendo compatibilidade com a chamada antiga (BullMQ)
        const delayMs = opts?.backoff?.delay || 2000;
        const delaySeconds = Math.max(1, Math.floor(delayMs / 1000));
        const limit = opts?.attempts ?? 3;

        await boss.send('messages', data as any, { 
            singletonKey: opts?.jobId,
            retryLimit: limit,
            retryDelay: delaySeconds,
            retryBackoff: true
        });
    }
};
