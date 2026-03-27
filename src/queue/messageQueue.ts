import { Queue } from 'bullmq';
import { createClient } from './redisClient.js';
import type { WhatsAppMessage } from '../lib/whatsapp.js';

const connection = createClient();


/**
 * Fila principal onde o Webhook deposita as mensagens do WhatsApp.
 * BullMQ garante que nenhuma mensagem seja perdida em caso de reinicialização do servidor.
 */
export const messageQueue = new Queue<WhatsAppMessage>('messages', { connection });

