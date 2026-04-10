import type { WhatsAppMessage } from '../lib/whatsapp.js';
import { boss } from './pgBossClient.js';

export const messageQueue = {
    add: async (name: string, data: WhatsAppMessage, opts?: any) => {
        // Envia para o pg-boss mantendo compatibilidade com a chamada antiga
        await boss.send('messages', data as any, { 
            singletonKey: opts?.jobId,
            retryLimit: opts?.attempts,
            retryDelay: 2
        });
    }
};
