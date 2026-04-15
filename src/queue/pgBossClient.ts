import { PgBoss } from 'pg-boss';
import { logger } from '../lib/logger.js';

// Conecta via DATABASE_URL mas com TCP keepAlive ativo para sobreviver
// ao timeout de conexão ociosa do Supabase/PgBouncer (~5 min por padrão).
// Type cast necessário pois keepAlive/keepAliveInitialDelayMillis são
// opções do pg.PoolConfig subjacente, não expostas no ConstructorOptions.
export const boss = new PgBoss({
    connectionString: process.env.DATABASE_URL!,

    // ── POOL ───────────────────────────────────────────────────────────────
    max: 2,                     // pg-boss usa no máximo 2 conexões (polling + maint)
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,  // recicla conexões ociosas antes do Supabase matar

    // ── KEEP-ALIVE (pg.PoolConfig) ─────────────────────────────────────────
    // Envia pacotes TCP periódicos para manter o socket ativo com o Supabase.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,

    // ── RETRY ──────────────────────────────────────────────────────────────
    retryLimit: 5,
    retryDelay: 3,
    retryBackoff: true,
} as any);

boss.on('error', (error: any) => logger.error({ err: error }, '[PgBoss] Erro interno da fila'));

export async function startQueue() {
    await boss.start();
    await boss.createQueue('messages');
    
    // Sprint Validade: Agendamento diário às 09:00 AM
    await boss.schedule('check-validity', '0 9 * * *');
    
    logger.info('[PgBoss] Fila iniciada e agendamentos configurados');
}
