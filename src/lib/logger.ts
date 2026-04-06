/**
 * Logger estruturado usando Pino (já incluso como dep do Fastify).
 * Substitui console.log/error em todo o projeto — logs com timestamp,
 * nível e contexto, rastreáveis em produção.
 */
import pino from 'pino';

export const logger = pino({
    level: process.env.LOG_LEVEL ?? 'info',
    transport:
        process.env.NODE_ENV !== 'production'
            ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } }
            : undefined,
});

/**
 * Cria um logger filho com contexto fixo (from, estado).
 * Use-o dentro do processMessage para rastrear uma conversa inteira.
 */
export function criarLoggerConversa(from: string, estado?: string) {
    return logger.child({ from, estado });
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
