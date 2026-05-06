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
// Token Bucket para Anti-Flood de Texto em IDLE (Proteção Global)
// ============================================================
const BUCKET_TEXTO_LIMITE = 20;           // máx de msgs texto em IDLE por janela
const BUCKET_TEXTO_JANELA = 60 * 1000;    // janela de 1 minuto (ms)

/**
 * Incrementa o contador de textos e impede text-flooding do bot.
 * Usado antes de acionar a detecção NLP.
 */
export function incrementarBucketFloodTexto(whatsapp: string): boolean {
    const key = `bucket_texto:${whatsapp}`;
    const entry = cache.get(key) as { count: number } | null;

    if (!entry) {
        cache.set(key, { count: 1 }, BUCKET_TEXTO_JANELA);
        return false;
    }

    const novoCount = entry.count + 1;
    cache.set(key, { count: novoCount }, BUCKET_TEXTO_JANELA);
    return novoCount > BUCKET_TEXTO_LIMITE;
}

export function ttlBucketFloodTexto(whatsapp: string): number {
    const key = `bucket_texto:${whatsapp}`;
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

// ============================================================
// Filtro de Hash de Mídia (Anti-token-waste para fotos duplicadas)
// ============================================================
const TTL_MEDIA_HASH = 10 * 60 * 1000; // 10 minutos

/**
 * Registra o hash SHA-256 de uma mídia processada.
 * Retorna true se a mídia JÁ foi processada recentemente (duplicata),
 * ou false se é nova (e registra o hash para futuras verificações).
 */
export function verificarHashMidia(whatsapp: string, hashHex: string): boolean {
    const key = `media_hash:${whatsapp}:${hashHex}`;
    if (cache.get(key)) return true; // duplicata detectada
    cache.set(key, true, TTL_MEDIA_HASH);
    return false; // nova mídia — hash registrado
}

// ============================================================
// Fusível de Tokens por Número (Proteção Financeira)
// ============================================================

// Limites diários por número de telefone
const TOKEN_LIMITE_NORMAL  = 500_000;   // Uso normal: ~400 mensagens/dia
const TOKEN_LIMITE_PREMIUM = 1_500_000; // Lojas Premium: ~1200 mensagens/dia
const TOKEN_LIMITE_IMPORTACAO = 5_000_000; // Importação de estoque grande (primeiro uso)
const TOKEN_AVISO_PERCENT  = 0.8;       // Avisa o operador ao atingir 80%


interface TokenBucket {
    total: number;
    avisado: boolean;
    limiteDiario: number;
}

/**
 * Calcula ms até a meia-noite local (quando o contador reseta).
 */
function msMeianoite(): number {
    const agora = new Date();
    const meianoite = new Date(agora);
    meianoite.setHours(24, 0, 0, 0);
    return meianoite.getTime() - agora.getTime();
}

/**
 * Adiciona tokens ao contador do número e verifica se o limite foi atingido.
 * Retorna: 'ok' | 'aviso' | 'bloqueado'
 */
export function incrementarTokens(whatsapp: string, tokens: number, limiteCustom?: number): 'ok' | 'aviso' | 'bloqueado' {
    const key = `tokens_dia:${whatsapp}`;
    const ttl = msMeianoite();

    const entry = cache.get(key) as TokenBucket | null;
    const atual = entry?.total ?? 0;
    const novoTotal = atual + tokens;
    // Se não passar limite, mantém o que já estava no bucket (caso tenha sido atualizado por um login premium)
    const limiteReal = limiteCustom ?? entry?.limiteDiario ?? TOKEN_LIMITE_NORMAL;

    const bucket: TokenBucket = {
        total: novoTotal,
        avisado: entry?.avisado ?? false,
        limiteDiario: limiteReal
    };

    cache.set(key, bucket, ttl);

    if (novoTotal >= limiteReal) return 'bloqueado';
    if (!bucket.avisado && novoTotal >= limiteReal * TOKEN_AVISO_PERCENT) {
        // Marca como avisado para não repetir o aviso
        cache.set(key, { ...bucket, avisado: true }, ttl);
        return 'aviso';
    }
    return 'ok';
}

/**
 * Verifica se o número já está bloqueado ANTES de chamar a API.
 * Use isso no início de cada job para evitar desperdício.
 */
export function verificarBloqueioTokens(whatsapp: string): boolean {
    const key = `tokens_dia:${whatsapp}`;
    const entry = cache.get(key) as TokenBucket | null;
    const limite = entry?.limiteDiario ?? TOKEN_LIMITE_NORMAL;
    return (entry?.total ?? 0) >= limite;
}

/**
 * Retorna o total de tokens usados hoje pelo número.
 */
export function getTokensUsados(whatsapp: string): number {
    const key = `tokens_dia:${whatsapp}`;
    const entry = cache.get(key) as TokenBucket | null;
    return entry?.total ?? 0;
}

export { TOKEN_LIMITE_NORMAL, TOKEN_LIMITE_PREMIUM, TOKEN_LIMITE_IMPORTACAO };

