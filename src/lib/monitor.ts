import { logger } from './logger.js';
import { supabaseAdmin } from './supabase.js';
import { enviarAlertaDono } from './whatsapp.js';

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

/**
 * Grava um evento de fluxo no Supabase exclusivamente se o número for o Owner.
 * Fire & Forget: não bloqueia a thread principal. Zero impacto na produção real.
 */
export function enviarLogAuditoria(args: {
    whatsapp: string;
    nivel: 'info' | 'warn' | 'error';
    contexto: string;
    mensagem: string;
    dados?: Record<string, unknown>;
}) {
    const ownerNumber = process.env.ACHAZAP_OWNER_NUMBER;
    if (!ownerNumber || args.whatsapp !== ownerNumber) return;  // Ignora usuários reais

    supabaseAdmin.from('logs_dev').insert([{
        whatsapp: args.whatsapp,
        nivel:    args.nivel,
        contexto: args.contexto,
        mensagem: args.mensagem,
        dados:    args.dados ?? null,
    }]).then(({ error }) => {
        if (error) logger.warn({ error }, '⚠️ Falha ao salvar log_dev no Supabase');
    });
}
