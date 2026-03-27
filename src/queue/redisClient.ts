import * as IORedisModule from 'ioredis';

const IORedis = (IORedisModule as any).default ?? IORedisModule;

/**
 * Cria uma conexão Redis compartilhada com configurações corretas para BullMQ.
 * Suporta tanto Redis local (dev) quanto Upstash (produção via rediss://).
 */
export function createClient() {
    const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
    const isTLS = url.startsWith('rediss://');

    return new IORedis(url, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        ...(isTLS ? { tls: {} } : {}),
    });
}

