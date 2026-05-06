/**
 * token-quota.ts — Fusível Financeiro Persistente (Anti-Custo-Explosão)
 * 
 * Substitui o contador de tokens em MemoryCache por Supabase.
 * Sobrevive a restarts do servidor. Usa função atômica no banco
 * para evitar race conditions em jobs paralelos.
 */
import { supabaseAdmin } from './supabase.js';
import { logger } from './logger.js';

// Limite global diário de tokens para jobs de background (Workers)
// Não confundir com limites por usuário (esses continuam no redis-cloud.ts)
export const QUOTA_WORKER_DIARIA = 2_000_000; // ~R$ 3,00/dia máximo
export const QUOTA_GLOBAL_DIARIA = 5_000_000; // teto absoluto do sistema

/**
 * Incrementa o contador persistente de tokens e retorna o status.
 * Usa upsert atômico no banco — seguro mesmo com múltiplos workers.
 * 
 * @param chave  Identificador da cota: 'worker', 'global', 'loja:<uuid>'
 * @param tokens Quantidade de tokens a adicionar
 * @param limite Limite diário para esta chave
 * @returns 'ok' | 'aviso' (80%) | 'bloqueado' (100%)
 */
export async function incrementarQuotaDB(
    chave: string,
    tokens: number,
    limite: number = QUOTA_WORKER_DIARIA
): Promise<'ok' | 'aviso' | 'bloqueado'> {
    try {
        const { data, error } = await supabaseAdmin.rpc('incrementar_token_quota', {
            p_chave:  chave,
            p_tokens: tokens,
            p_limite: limite,
        });

        if (error) {
            // Falha no banco: FAIL-CLOSED para evitar rombo se Supabase cair
            logger.error({ error: error.message, chave, tokens }, '🛡️ [DEFESA] Falha ao comunicar com Supabase RPC. Fail-closed ativado para evitar chamadas de API invisíveis.');
            return 'bloqueado';
        }

        const resultado = Array.isArray(data) ? data[0] : data;
        const totalNovo: number = resultado?.total_novo ?? 0;

        if (resultado?.bloqueado) {
            logger.error({ chave, totalNovo, limite }, '[TokenQuota] 🔴 LIMITE DIÁRIO ATINGIDO — bloqueando chamadas Gemini até meia-noite');
            return 'bloqueado';
        }

        if (totalNovo >= limite * 0.8) {
            logger.warn({ chave, totalNovo, limite, pct: Math.round(totalNovo / limite * 100) }, '[TokenQuota] ⚠️ 80% da quota diária consumida');
            return 'aviso';
        }

        return 'ok';
    } catch (e) {
        logger.error({ e, chave }, '🛡️ [DEFESA] Exceção crítica ao registrar quota — fail-closed ativado.');
        return 'bloqueado';
    }
}

/**
 * Verifica se a chave está bloqueada ANTES de chamar a API.
 * Chame isso no início de cada job/lote para evitar desperdício.
 */
export async function verificarQuotaBloqueadaDB(
    chave: string,
    limite: number = QUOTA_WORKER_DIARIA
): Promise<boolean> {
    try {
        const { data, error } = await supabaseAdmin.rpc('verificar_quota_bloqueada', {
            p_chave:  chave,
            p_limite: limite,
        });
        if (error) return true; // fail-closed (bloqueado)
        return data === true;
    } catch {
        return true; // fail-closed (bloqueado)
    }
}

/**
 * Retorna o consumo atual de todas as chaves do dia.
 * Usado pelo script de auditoria.
 */
export async function getQuotaHoje(): Promise<Array<{ chave: string; total: number; bloqueado: boolean }>> {
    const { data } = await supabaseAdmin.from('v_token_quota_hoje').select('*');
    return data ?? [];
}
