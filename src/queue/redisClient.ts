import * as IORedisModule from 'ioredis';

const IORedis = (IORedisModule as any).default ?? IORedisModule;

/**
 * Cria conexão Redis para BullMQ.
 * Usa a mesma REDIS_URL que o redis-cloud.ts (sem split-brain).
 */
export function createClient() {
    const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
    const isTLS = url.startsWith('rediss://');

    return new IORedis(url, {
        maxRetriesPerRequest: null,  // obrigatório para BullMQ
        enableReadyCheck: false,
        ...(isTLS ? { tls: {} } : {}),
    });
}

