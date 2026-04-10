import { PgBoss } from 'pg-boss';
import { logger } from '../lib/logger.js';

export const boss = new PgBoss(process.env.DATABASE_URL!);

boss.on('error', (error: any) => logger.error({ err: error }, '[PgBoss] Erro interno da fila'));

export async function startQueue() {
    await boss.start();
    // pg-boss v10+ exige que a fila seja criada explicitamente antes do uso
    await boss.createQueue('messages');
    logger.info('[PgBoss] Fila iniciada com sucesso (PostgreSQL)');
}
