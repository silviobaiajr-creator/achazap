import 'dotenv/config';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { processarCSV } from '../csvProcessor.js';
import { pool } from '../../lib/db.js';
import * as whatsapp from '../../lib/whatsapp.js';
import { ai } from '../../lib/gemini.js';
import { performance } from 'perf_hooks';

// Ativa bypass para o teste
process.env.ALLOW_LARGE_CSV = 'true';

describe('CSV Stress Test (100k Produtos)', () => {
    
    // Mock do Gemini para mapeamento fixo (zero latência/cost)
    vi.mock('../../lib/gemini.js', () => ({
        ai: {
            models: {
                generateContent: vi.fn().mockResolvedValue({
                    text: JSON.stringify({
                        coluna_nome: 'produto',
                        coluna_preco: 'preco',
                        coluna_unidade: 'unidade',
                        coluna_sku: 'sku'
                    }),
                    usageMetadata: { totalTokens: 0 }
                })
            }
        },
        GEMINI_MODEL: 'gemini-1.5-flash'
    }));

    // Mock do WhatsApp
    vi.spyOn(whatsapp, 'sendTextMessage').mockResolvedValue(undefined);
    const downloadSpy = vi.spyOn(whatsapp, 'downloadMedia');

    const TOTAL_LINHAS = 100000;
    let csvBuffer: Buffer;

    beforeAll(() => {
        console.log(`\n🚀 [STRESS TEST] Gerando ${TOTAL_LINHAS} linhas de CSV...`);
        const header = "produto;preco;unidade;sku\n";
        let body = "";
        for (let i = 1; i <= TOTAL_LINHAS; i++) {
            // Cada linha tem ~40-50 caracteres
            body += `Produto Stress Test Numero ${i};${(Math.random() * 100).toFixed(2)};un;SKU-${i}\n`;
            
            // Intervalo para não travar a geração no loop síncrono muito tempo
            if (i % 10000 === 0) console.log(`   - Geradas ${i} linhas...`);
        }
        csvBuffer = Buffer.from(header + body);
        console.log(`📂 Tamanho do arquivo gerado: ${(csvBuffer.length / 1024 / 1024).toFixed(2)} MB`);
    });

    afterAll(async () => {
        // Limpar dados de teste para não poluir permanentemente (opcional, conforme plano)
        // await pool.query("DELETE FROM catalogo_historico WHERE fonte_ingestao = 'csv' AND produto_nome LIKE 'Produto Stress Test%'");
        await pool.end();
    });

    it('deve processar 100k produtos sem estourar o limite de RAM', async () => {
        const initialState = process.memoryUsage();
        console.log(`\n📊 [Telemetria Inicial] RSS: ${(initialState.rss / 1024 / 1024).toFixed(2)} MB, Heap: ${(initialState.heapUsed / 1024 / 1024).toFixed(2)} MB`);

        downloadSpy.mockResolvedValue(csvBuffer);

        const mockMsg = {
            from: '5511999999999',
            document: { id: 'stress_test_doc_id', file_size: csvBuffer.length }
        };

        const mockLoja = { id: '11111111-0000-0000-0000-000000000002', nome: 'Loja de Stress' }; // ID real vindo do seed

        const startTime = performance.now();
        
        // EXECUÇÃO
        const sendTextMessageSpy = vi.spyOn(whatsapp, 'sendTextMessage');
        
        await processarCSV(mockMsg, mockMsg.from, mockLoja, {});

        const lastCall = sendTextMessageSpy.mock.calls[sendTextMessageSpy.mock.calls.length - 1];
        console.log(`💬 Última mensagem enviada: ${lastCall ? lastCall[1] : 'NENHUMA'}`);

        const endTime = performance.now();
        const duration = (endTime - startTime) / 1000;

        const finalState = process.memoryUsage();
        const heapDiff = (finalState.heapUsed - initialState.heapUsed) / 1024 / 1024;

        console.log(`\n✅ [FINALIZADO]`);
        console.log(`⏱️ Tempo Total: ${duration.toFixed(2)} segundos`);
        console.log(`📈 Velocidade: ${(TOTAL_LINHAS / duration).toFixed(0)} produtos/seg`);
        console.log(`🧠 Consumo Final Heap: ${(finalState.heapUsed / 1024 / 1024).toFixed(2)} MB`);
        console.log(`🔼 Delta Heap: ${heapDiff.toFixed(2)} MB`);

        // Assertions básicas
        expect(duration).toBeLessThan(600); // 10 min — bulk insert deve completar 100k linhas neste prazo
        expect(finalState.heapUsed).toBeLessThan(512 * 1024 * 1024); // Limite de 512MB para segurança
    }, 600000); // 10 min — benchmark de 100k itens contra banco remoto

});
