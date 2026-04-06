import { Redis } from 'ioredis';

// ============================================================
// Singleton unificado — usa REDIS_URL tanto para estado
// de conversas quanto para o BullMQ (sem split-brain)
// ============================================================

let redisClient: Redis | null = null;

export function getRedisCloudClient(): Redis {
    if (!redisClient) {
        const url = process.env.REDIS_URL;

        if (!url) {
            console.warn('[Redis] ⚠️ REDIS_URL não definida. Usando Redis local (fallback dev).');
            redisClient = new Redis({
                host: 'localhost',
                port: 6379,
                lazyConnect: true,
                maxRetriesPerRequest: 3,
            });
        } else {
            const isTLS = url.startsWith('rediss://');
            redisClient = new Redis(url, {
                maxRetriesPerRequest: 3,
                retryStrategy: (times: number) => {
                    if (times > 5) {
                        console.error('[Redis] ❌ Máximo de tentativas excedido — Redis indisponível');
                        return null; // para de tentar, não derruba o processo
                    }
                    return Math.min(times * 300, 3000);
                },
                enableReadyCheck: true,
                ...(isTLS ? { tls: {} } : {}),
            });

            redisClient.on('error', (err) => {
                // Evita crash por UnhandledError — apenas loga
                console.error('[Redis] ❌ Erro de conexão:', err.message);
            });
        }
    }
    return redisClient;
}

export async function obterRedis(): Promise<Redis> {
    return getRedisCloudClient();
}

// ============================================================
// Funções de Estado da Conversa (Máquina de Estados)
// ============================================================

const TTL_CONTEXTO = 1800; // 30 minutos (estado ativo)
const TTL_WAMID    = 300;  // 5 minutos (idempotência de mensagem)

/**
 * Idempotência de mensagens da Meta.
 * Retorna true se já foi processada (duplicata), false se é nova.
 */
export async function marcarWamidProcessado(wamid: string): Promise<boolean> {
    const client = getRedisCloudClient();
    try {
        // SET NX: só grava se ainda não existir. Retorna 'OK' ou null.
        const resultado = await client.set(`wam:${wamid}`, '1', 'EX', TTL_WAMID, 'NX');
        return resultado === null; // null = já existia = é duplicata
    } catch (err) {
        console.error('[Redis] ❌ Erro ao verificar wamid:', err);
        return false; // em caso de falha no Redis, permite processar (fail-open)
    }
}

/**
 * Salva contexto completo da conversa (substitui salvarEstado legado).
 */
export async function salvarContexto(whatsapp: string, contexto: Record<string, any>): Promise<void> {
    const client = getRedisCloudClient();
    try {
        await client.set(`ctx:${whatsapp}`, JSON.stringify(contexto), 'EX', TTL_CONTEXTO);
    } catch (err) {
        console.error('[Redis] ❌ Erro ao salvar contexto:', err);
        // Não relança — falha do Redis não derruba o fluxo
    }
}

/**
 * Lê contexto da conversa. Retorna null se não existir ou Redis falhar.
 */
export async function lerContexto(whatsapp: string): Promise<Record<string, any> | null> {
    const client = getRedisCloudClient();
    try {
        const raw = await client.get(`ctx:${whatsapp}`);
        return raw ? JSON.parse(raw) : null;
    } catch (err) {
        console.error('[Redis] ❌ Erro ao ler contexto:', err);
        return null;
    }
}

/**
 * Remove contexto (volta para IDLE).
 */
export async function limparContexto(whatsapp: string): Promise<void> {
    const client = getRedisCloudClient();
    try {
        await client.del(`ctx:${whatsapp}`);
    } catch (err) {
        console.error('[Redis] ❌ Erro ao limpar contexto:', err);
    }
}

/**
 * Renova TTL do contexto sem alterar os dados (preserva estado em erros de validação).
 */
export async function renovarTTLContexto(whatsapp: string): Promise<void> {
    const client = getRedisCloudClient();
    try {
        await client.expire(`ctx:${whatsapp}`, TTL_CONTEXTO);
    } catch (err) {
        console.error('[Redis] ❌ Erro ao renovar TTL:', err);
    }
}

/**
 * Lock de concorrência (mutex simples com NX).
 * Retorna true se conseguiu o lock, false se já estava bloqueado.
 */
export async function adquirirLock(chave: string, ttlSegundos: number = 10): Promise<boolean> {
    const client = getRedisCloudClient();
    try {
        const resultado = await client.set(`lock:${chave}`, '1', 'EX', ttlSegundos, 'NX');
        return resultado === 'OK';
    } catch (err) {
        console.error('[Redis] ❌ Erro ao adquirir lock:', err);
        return false; // fail-open: não bloqueia o fluxo se Redis falhar
    }
}

/**
 * Libera lock de concorrência.
 */
export async function liberarLock(chave: string): Promise<void> {
    const client = getRedisCloudClient();
    try {
        await client.del(`lock:${chave}`);
    } catch (err) {
        console.error('[Redis] ❌ Erro ao liberar lock:', err);
    }
}

// Aliases legados para compatibilidade com server.ts e index.ts
export const lerEstado = lerContexto;
export const limparEstado = limparContexto;
export async function salvarEstado(whatsapp: string, estado: string, dados: any = null): Promise<void> {
    await salvarContexto(whatsapp, { estado, ...(dados ?? {}) });
}

export async function verificarConexao(): Promise<boolean> {
    try {
        await getRedisCloudClient().ping();
        return true;
    } catch {
        return false;
    }
}
