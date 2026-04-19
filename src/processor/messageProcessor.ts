import { processMessage } from '../ai/orchestrator.js';
import type { WhatsAppMessage } from '../lib/whatsapp.js';
import { logger } from '../lib/logger.js';
import { boss } from '../queue/pgBossClient.js';
import { logErroCritico } from '../lib/monitor.js';
import { enviarLogAuditoria } from '../lib/audit.js';

/**
 * Inicializador da rotina que desempilha mensagens do banco.
 * O pg-boss cuida do limite de concorrência e das re-tentativas baseadas no timeout.
 */
export async function startMessageWorker() {
    await boss.work('messages', {
        teamSize: 5,
        teamConcurrency: 5,
        newJobCheckInterval: 500, // QA Fix: Busca novos jobs a cada 500ms
    } as any, async (args: any) => { 
        let currentFrom: string | undefined;
        try {
            // Dependendo da versão do pg-boss, o args pode vir como array (por retrocompatibilidade)
            const job = Array.isArray(args) ? args[0] : args;
            if (!job || !job.data) {
                logger.warn({ args }, '[Processor] Job vazio / mal formatado bloqueado');
                return;
            }

            const message = job.data;
            currentFrom = message.from;
            const msgId = job.id;
            
            logger.info({ jobId: msgId, from: message.from, type: message.type }, '[Processor] Iniciando job (pg-boss)');

            // Grampo de Auditoria — registra no Supabase se for o Owner
            enviarLogAuditoria({
                whatsapp: message.from,
                nivel: 'info',
                contexto: 'PROCESSOR',
                mensagem: `[Processor] Job iniciado — tipo: ${message.type}`,
                dados: { jobId: msgId, type: message.type }
            });

            await processMessage(message);

            // Registra conclusão bem-sucedida
            enviarLogAuditoria({
                whatsapp: message.from,
                nivel: 'info',
                contexto: 'PROCESSOR',
                mensagem: '[Processor] Job processado com sucesso',
                dados: { jobId: msgId }
            });
        } catch (err: any) {
            // Isolamento total da Stack: previne "Cannot read properties" ocultos fora do try
            await logErroCritico({
                origem: 'PROCESSOR',
                whatsapp: currentFrom,
                mensagem: `Falha ao processar mensagem: ${err.message}`,
                err
            });
            throw err;
        }
    });
    logger.info('[Processor] Worker ativo com pg-boss (concorrência ajustada, batch desligado)');
}
