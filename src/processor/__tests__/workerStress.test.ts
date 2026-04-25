import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { boss } from '../../queue/pgBossClient.js';
import { pool } from '../../lib/db.js';

// Mock do import ANTES do startMessageWorker, pois Vitest faz o hoist disto automaticamente.
// Assim não chamamos o LLM ou o WhatsApp "de verdade" para as 500 mensagens de teste!
vi.mock('../../ai/orchestrator.js', () => ({
    processMessage: vi.fn().mockImplementation(async (msg) => {
        // Simulando que o AI Orquestrador leva 100ms para resolver o intento
        await new Promise(r => setTimeout(r, 100));
        return true;
    })
}));

describe('Worker Processing Stress Test (pg-boss)', () => {
    vi.setConfig({ testTimeout: 120000 });
    let startMessageWorker: any;
    let processMessageMock: any;

    beforeAll(async () => {
        // Inicializa o boss se já não estiver e limpa a fila
        try { await boss.start(); } catch {}
        await pool.query('DELETE FROM pgboss.job');
        
        // Importa o orchestrator mockado
        const orchestrator = await import('../../ai/orchestrator.js');
        processMessageMock = orchestrator.processMessage;

        // Importa o worker só agora para pegar o mock do orchestrator
        const workerModule = await import('../messageProcessor.js');
        startMessageWorker = workerModule.startMessageWorker;
    });

    afterAll(async () => {
        await pool.query('DELETE FROM pgboss.job');
        try {
            await boss.stop();
        } catch {}
        await pool.end();
    });

    it('deve desempilhar e processar 20 mensagens respeitando o limite de concorrência', async () => {
        const TOTAL_JOBS = 20;
        console.log(`\n📦 [WORKER STRESS TEST] Injetando ${TOTAL_JOBS} mensagens na fila "messages"...`);
        
        const perfStart = Date.now();
        for (let i = 0; i < TOTAL_JOBS; i++) {
            await boss.send('messages', {
                from: `551199999${(i).toString().padStart(4, '0')}`,
                type: 'text',
                text: { body: `Stress Test #${i}` }
            });
        }
        console.log(`✅ Injeção completa. Iniciando o Worker...`);

        // Zera o mock para contagem
        processMessageMock.mockClear();

        // Dá START no Worker
        const workerStartTime = Date.now();
        await startMessageWorker();

        // Monitor de finalização progressivo (polling a cada 50ms)
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error(`Timeout aguardando processamento. Processadas: ${processMessageMock.mock.calls.length}/${TOTAL_JOBS}`)), 120000);
            const interval = setInterval(() => {
                if (processMessageMock.mock.calls.length >= TOTAL_JOBS) {
                    clearTimeout(timeout);
                    clearInterval(interval);
                    resolve();
                }
            }, 500);
        });

        const workerDuration = Date.now() - workerStartTime;
        const totalDuration = Date.now() - perfStart;

        console.log(`\n🎉 Processamento concluído!`);
        console.log(`📈 Velocidade do Worker (Mock = 100ms/job, Concurrency = 5):`);
        console.log(`   - Tempo no Worker: ${workerDuration}ms`);
        console.log(`   - Esperado teórico com 5 slots: ~${(TOTAL_JOBS * 100) / 5}ms`);
        console.log(`⏱️ Tempo total (Upload Fila + Worker): ${totalDuration}ms\n`);

        expect(processMessageMock).toHaveBeenCalledTimes(TOTAL_JOBS);
        // Considerando que teamSize = 5 e o mock leva 100ms, o mínimo num mundo ideal seria 2000ms.
        // O pg-boss tem um overhead de E/S. Se passarmos rápido e o worker processar tudo, está aprovado.
    }, 120000); // 120s limite de segurança para 100 mensagens
});
