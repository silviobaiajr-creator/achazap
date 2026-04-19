/**
 * Logger estruturado usando Pino (já incluso como dep do Fastify).
 * Substitui console.log/error em todo o projeto — logs com timestamp,
 * nível e contexto, rastreáveis em produção.
 */
import pino from 'pino';
import { enviarLogAuditoria } from './monitor.js';

export const logger = pino({
    level: process.env.LOG_LEVEL ?? 'info',
    transport:
        process.env.NODE_ENV !== 'production'
            ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } }
            : undefined,
});

/**
 * Cria um logger filho com contexto fixo (from, estado).
 * Se o `from` for o número do Owner, instala um "Grampo de Auditoria":
 * cada linha de log é espelhada silenciosamente no Supabase (logs_dev).
 */
export function criarLoggerConversa(from: string, estado?: string) {
    const child = logger.child({ from, estado });
    const ownerNumber = process.env.ACHAZAP_OWNER_NUMBER;

    if (!ownerNumber || from !== ownerNumber) return child;

    // --- Grampo de Auditoria (só ativo para o Owner) ---
    const ctx = estado ?? 'DESCONHECIDO';
    const intercept = (nivel: 'info' | 'warn' | 'error') =>
        (dadosOuMsg: any, msg?: string) => {
            const mensagem = typeof dadosOuMsg === 'string' ? dadosOuMsg : (msg ?? '');
            const dados    = typeof dadosOuMsg === 'object' ? dadosOuMsg : undefined;
            enviarLogAuditoria({ whatsapp: from, nivel, contexto: ctx, mensagem, dados });
            return (child[nivel] as any)(dadosOuMsg, msg);
        };

    return Object.assign(Object.create(child), {
        info:  intercept('info'),
        warn:  intercept('warn'),
        error: intercept('error'),
    });
}

/**
 * Loga o uso de tokens de uma chamada ao Gemini (4.2 — controle de custo).
 * Persiste no console estruturado para análise posterior.
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
    logger.info({
        tipo: 'gemini_tokens',
        operacao,
        from,
        loja_id: lojaId,
        tokens_entrada: usageMetadata.promptTokenCount ?? 0,
        tokens_saida:   usageMetadata.candidatesTokenCount ?? 0,
        tokens_total:   usageMetadata.totalTokenCount ?? 0,
    }, `[Gemini] ${operacao} — ${usageMetadata.totalTokenCount ?? '?'} tokens`);
}
