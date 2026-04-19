import { logger } from './logger.js';
import { supabaseAdmin } from './supabase.js';
import { enviarAlertaDono } from './whatsapp.js';
import { env } from '../config.js';
export { enviarLogAuditoria } from './audit.js';

/**
 * Função central para logar erros críticos.
 * 1. Registra no Pino (Console/CloudWatch)
 * 2. Salva no Supabase (Persistência para auditoria)
 * 3. Envia para o WhatsApp do Dono (Alerta imediato)
 */
export async function logErroCritico(args: {
    origem: 'PROCESSOR' | 'WEBHOOK' | 'GLOBAL' | 'DB' | 'AI' | 'FLUXO_TESTE';
    whatsapp?: string;
    mensagem: string;
    err?: any;
    contexto?: any;
}) {
    const { origem, whatsapp, mensagem, err, contexto } = args;
    
    // 1. Log Estruturado
    logger.error({ 
        origem, 
        from: whatsapp, 
        err: err?.message || err, 
        contexto 
    }, `[${origem}] ${mensagem}`);

    // 2. Persistência no Banco (Fire & Forget interno para não travar o fluxo)
    supabaseAdmin.from('logs_erro').insert([{
        origem,
        whatsapp,
        mensagem,
        stack_trace: err?.stack || String(err),
        contexto: contexto || null
    }]).then(({ error }) => {
        if (error) logger.error({ error }, '❌ Falha ao salvar log_erro no Supabase');
    });

    // 3. Alerta no WhatsApp (Com trava de spam interna na função)
    await enviarAlertaDono(mensagem, `*Origem:* ${origem}${whatsapp ? `\n*Lojista:* ${whatsapp}` : ''}`);
}

