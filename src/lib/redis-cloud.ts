// ============================================================
// Cache em Memória (Substitui o Redis/Upstash)
// ============================================================
// O servidor hospeda a memória ativa.
// Para clusters (múltiplas instâncias Node), escalar para Postgres/Supabase real.

import { logger } from './logger.js';

const TTL_CONTEXTO = 1800 * 1000; // 30 minutos (ms)
const TTL_WAMID    = 300 * 1000;  // 5 minutos (ms)

interface CacheEntry<T> {
    data: T;
    expiresAt: number;
}

class MemoryCache {
    private store = new Map<string, CacheEntry<any>>();

    set(key: string, value: any, ttlMs: number) {
        this.store.set(key, {
            data: value,
            expiresAt: Date.now() + ttlMs,
        });
    }

    get(key: string) {
        const item = this.store.get(key);
        if (!item) return null;
        if (item.expiresAt < Date.now()) {
            this.store.delete(key);
            return null;
        }
        return item.data;
    }

    delete(key: string) {
        this.store.delete(key);
    }
}

export const cache = new MemoryCache();

// Limpeza natural (Garbage Collection Manual)
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of cache['store'].entries()) {
        if (entry.expiresAt < now) cache['store'].delete(key);
    }
}, 60000); // 1 minuto

// ============================================================
// Funções de Idempotência e Estado
// ============================================================

export async function adquirirLock(key: string, ttlSeconds: number): Promise<boolean> {
    if (cache.get(key)) return false; // lock já existe (ocupado)
    cache.set(key, true, ttlSeconds * 1000);
    return true; // obteve lock
}

export async function liberarLock(key: string): Promise<void> {
    cache.delete(key);
}

export async function marcarWamidProcessado(wamid: string): Promise<boolean> {
    const key = `wam:${wamid}`;
    if (cache.get(key)) return true; // já processado
    cache.set(key, true, TTL_WAMID);
    return false;
}

export async function salvarContexto(whatsapp: string, contexto: Record<string, any>): Promise<void> {
    cache.set(`ctx:${whatsapp}`, contexto, TTL_CONTEXTO);
}

export async function lerContexto(whatsapp: string): Promise<Record<string, any> | null> {
    return cache.get(`ctx:${whatsapp}`) || null;
}

export async function limparContexto(whatsapp: string): Promise<void> {
    cache.delete(`ctx:${whatsapp}`);
}

export async function renovarTTLContexto(whatsapp: string): Promise<void> {
    const ctx = cache.get(`ctx:${whatsapp}`);
    if (ctx) cache.set(`ctx:${whatsapp}`, ctx, TTL_CONTEXTO);
}

export async function verificarConexao(): Promise<boolean> {
    return true; // sempre true pois está em memória nativa
}

// ============================================================
// Token Bucket para Mídias (Camada 3 de proteção proativa)
// ============================================================
const BUCKET_MIDIA_LIMITE = 10;           // máx de mídias por janela
const BUCKET_MIDIA_JANELA = 60 * 60 * 1000; // janela de 1 hora (ms)

/**
 * Incrementa o contador de mídias do lojista.
 * Retorna true se o limite foi EXCEDIDO, false se ainda está dentro do limite.
 */
export function incrementarBucketMidia(whatsapp: string): boolean {
    const key = `bucket_midia:${whatsapp}`;
    const entry = cache.get(key) as { count: number } | null;

    if (!entry) {
        cache.set(key, { count: 1 }, BUCKET_MIDIA_JANELA);
        return false;
    }

    const novoCount = entry.count + 1;
    cache.set(key, { count: novoCount }, BUCKET_MIDIA_JANELA);
    return novoCount > BUCKET_MIDIA_LIMITE;
}

/**
 * Retorna o tempo restante (em segundos) até o bucket resetar.
 * Retorna 0 se não houver bucket ativo.
 */
export function ttlBucketMidia(whatsapp: string): number {
    const key = `bucket_midia:${whatsapp}`;
    const raw = (cache as any)['store'].get(key) as { expiresAt: number } | undefined;
    if (!raw) return 0;
    const msRestante = Math.max(0, raw.expiresAt - Date.now());
    return Math.ceil(msRestante / 1000);
}

// ============================================================
// Escudo Global de Spam (Proteção para bloqueios repetitivos)
// ============================================================

export function temAvisoSpam(whatsapp: string): boolean {
    return cache.get(`aviso_spam_midia:${whatsapp}`) !== null;
}

export function setAvisoSpam(whatsapp: string, ttlSegundos: number): void {
    try {
        cache.set(`aviso_spam_midia:${whatsapp}`, true, ttlSegundos * 1000);
    } catch { /* ignora erros de memória locais */ }
}
