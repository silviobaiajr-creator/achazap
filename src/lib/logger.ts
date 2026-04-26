/**
 * Logger estruturado usando Pino (já incluso como dep do Fastify).
 * Substitui console.log/error em todo o projeto — logs com timestamp,
 * nível e contexto, rastreáveis em produção.
 */
import pino from 'pino';
import { enviarLogAuditoria } from './audit.js';

// --- Configuração do Logger Principal ---
const pinoLogger = pino({
    level: process.env.LOG_LEVEL ?? 'info',
    transport:
        process.env.NODE_ENV !== 'production'
            ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } }
            : undefined,
});

/**
 * Universal Mirror (Sprint 15)
 * Intercepta os métodos de log do Pino. Se houver um campo 'from' (número do WhatsApp),
 * envia uma cópia para o Supabase (logs_dev).
 */
function wrapLogger(baseLogger: any) {
    const intercept = (method: string) => {
        const original = baseLogger[method].bind(baseLogger);
        return (dadosOuMsg: any, msg?: string) => {
            // Executa o log original no console (Render)
            original(dadosOuMsg, msg);

            // Tenta extrair o número do WhatsApp e o contexto
            const dados = typeof dadosOuMsg === 'object' ? dadosOuMsg : {};
            const from = dados.from || dados.whatsapp;
            const mensagem = typeof dadosOuMsg === 'string' ? dadosOuMsg : (msg ?? '');

            // Só espelha se tiver um número de WhatsApp e não for nível 'debug'
            if (from && typeof from === 'string' && method !== 'debug') {
                enviarLogAuditoria({
                    whatsapp: from,
                    nivel: method as any,
                    contexto: dados.contexto || dados.estado || 'SISTEMA',
                    mensagem: mensagem,
                    dados: dados
                });
            }
        };
    };

    const wrapped = {
        ...baseLogger,
        info:  intercept('info'),
        warn:  intercept('warn'),
        error: intercept('error'),
        debug: baseLogger.debug.bind(baseLogger), // Debug não espelha para poupar DB
    };

    // Ajusta o método child para retornar um logger também "wrappado"
    wrapped.child = (bindings: any) => wrapLogger(baseLogger.child(bindings));
    
    return wrapped;
}

export const logger = wrapLogger(pinoLogger);

export function criarLoggerConversa(from: string, estado?: string) {
    return logger.child({ from, estado });
}

/**
 * Loga o uso de tokens de uma chamada ao Gemini (4.2 — controle de custo).
 */
export function logTokens(
    operacao: string,
    from: string,
    lojaId: string,
    usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
    }
) {
    if (!usageMetadata) return;
    const tokensMsg = `[Gemini] ${operacao} — ${usageMetadata.totalTokenCount ?? '?'} tokens`;
    
    logger.info({
        tipo: 'gemini_tokens',
        operacao,
        from,
        loja_id: lojaId,
        tokens_entrada: usageMetadata.promptTokenCount ?? 0,
        tokens_saida:   usageMetadata.candidatesTokenCount ?? 0,
        tokens_total:   usageMetadata.totalTokenCount ?? 0,
    }, tokensMsg);
    
    // O envio para enviarLogAuditoria agora é automático via logger.info
}
