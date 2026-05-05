/**
 * tokenProtection.test.ts
 *
 * Suite de testes que PROVA, sem chamar a API real, que o sistema
 * não vai gerar consumo absurdo de tokens em nenhum cenário.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── vi.hoisted: mocks disponíveis antes do hoisting do vi.mock ───────────────
const { mockQuery, mockClient } = vi.hoisted(() => {
    const mockQuery  = vi.fn();
    const mockClient = { query: mockQuery, release: vi.fn() };
    return { mockQuery, mockClient };
});

const mockVerificarQuota   = vi.hoisted(() => vi.fn());
const mockIncrementarQuota = vi.hoisted(() => vi.fn());
const mockDecompor         = vi.hoisted(() => vi.fn());
const mockEmbedding        = vi.hoisted(() => vi.fn());

// ─── Mocks dos módulos ────────────────────────────────────────────────────────
vi.mock('../../lib/token-quota.js', () => ({
    verificarQuotaBloqueadaDB: mockVerificarQuota,
    incrementarQuotaDB:        mockIncrementarQuota,
    QUOTA_WORKER_DIARIA:       2_000_000,
}));

vi.mock('../../ai/skills/catalog-ledger.js', () => ({
    decomporProduto: mockDecompor,
    gerarEmbedding:  mockEmbedding,
}));

vi.mock('../../lib/logger.js', () => ({
    logger:    { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    logTokens: vi.fn(),
}));

vi.mock('../../lib/db.js', () => ({
    pool: { connect: vi.fn().mockResolvedValue(mockClient) },
}));

// pg-boss: captura o handler registrado pelo worker
let capturedHandler: ((args: any) => Promise<void>) | null = null;
vi.mock('../../queue/pgBossClient.js', () => ({
    boss: {
        work: vi.fn().mockImplementation((_name: string, handler: any) => {
            capturedHandler = handler;
            return Promise.resolve();
        }),
    },
}));

// ─── Import do worker APÓS todos os mocks ─────────────────────────────────────
import { startEmbeddingWorker } from '../embeddingWorker.js';

// ─── Helper: cria um lote de linhas para o mock do banco ──────────────────────
function linhasComMembros(qtd: number) {
    return Array.from({ length: qtd }, (_, i) => ({
        id: `p${i}`, produto_nome: `Produto ${i}`,
        membro_core: null, marca: null,
        especificacao: null, unidade_medida: null, metadados: null,
    }));
}

function linhasComMembroPreenchido(qtd: number) {
    return Array.from({ length: qtd }, (_, i) => ({
        id: `p${i}`, produto_nome: `Produto ${i}`,
        membro_core: 'Leite', marca: 'Marca X',
        especificacao: null, unidade_medida: null, metadados: null,
    }));
}

async function iniciarWorkerEExecutar(jobData = { lojaId: 'loja-teste' }) {
    await startEmbeddingWorker();
    if (capturedHandler) {
        await capturedHandler({ data: jobData, id: 'job-teste' });
    }
}

// ─── Testes ───────────────────────────────────────────────────────────────────
describe('Proteção de Custo — EmbeddingWorker', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        capturedHandler = null;
        // Defaults seguros
        mockIncrementarQuota.mockResolvedValue('ok');
        mockDecompor.mockResolvedValue({
            membro_core: 'Produto', marca: null,
            especificacao: null, unidade_medida: null, metadados: null,
        });
        mockEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
    });

    // ──────────────────────────────────────────────────────────────────────────
    it('TESTE 1: Quota bloqueada → ZERO chamadas ao Gemini', async () => {
        mockVerificarQuota.mockResolvedValue(true); // quota atingida
        mockQuery.mockResolvedValue({ rows: [] });

        await iniciarWorkerEExecutar();

        expect(mockDecompor).not.toHaveBeenCalled();
        expect(mockEmbedding).not.toHaveBeenCalled();
        console.log('\n✅ TESTE 1: Quota bloqueada = ZERO chamadas ao Gemini. Sem custo.');
    });

    // ──────────────────────────────────────────────────────────────────────────
    it('TESTE 2: membro_core preenchido → decomporProduto nunca é chamado', async () => {
        mockVerificarQuota.mockResolvedValue(false);

        const rows = linhasComMembroPreenchido(3);
        mockQuery
            .mockResolvedValueOnce({ rows })     // 1ª busca
            .mockResolvedValueOnce({ rows: [] }) // 2ª busca (fila vazia = encerra)
            .mockResolvedValue({ rows: [] });    // UPDATEs

        await iniciarWorkerEExecutar();

        // decomporProduto custa ~590 tokens. Com membro_core preenchido, nunca deve chamar.
        expect(mockDecompor).not.toHaveBeenCalled();
        // gerarEmbedding é barato (~10 tokens) e pode ser chamado
        expect(mockEmbedding).toHaveBeenCalledTimes(3);
        console.log('\n✅ TESTE 2: membro_core preenchido = 0 chamadas de decomposição (~0 tokens de custo alto)');
    });

    // ──────────────────────────────────────────────────────────────────────────
    it('TESTE 3: Chamadas ao Gemini são SEQUENCIAIS, não paralelas', async () => {
        const inicios: number[] = [];

        mockVerificarQuota.mockResolvedValue(false);
        mockDecompor.mockImplementation(async () => {
            inicios.push(Date.now());
            await new Promise(r => setTimeout(r, 80)); // simula 80ms de latência
            return { membro_core: 'P', marca: null, especificacao: null, unidade_medida: null, metadados: null };
        });

        const rows = linhasComMembros(3);
        mockQuery
            .mockResolvedValueOnce({ rows })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValue({ rows: [] });

        await iniciarWorkerEExecutar();

        expect(mockDecompor).toHaveBeenCalledTimes(3);

        // Se fossem paralelas (Promise.all), todos os timestamps seriam quase iguais (< 10ms de diff)
        // Se são sequenciais, cada início é pelo menos 80ms após o anterior
        for (let i = 1; i < inicios.length; i++) {
            const diff = inicios[i] - inicios[i - 1];
            expect(diff).toBeGreaterThanOrEqual(60); // 80ms latência - margem de 20ms
            console.log(`   Intervalo chamada ${i}→${i+1}: ${diff}ms (esperado ≥80ms)`);
        }
        console.log('\n✅ TESTE 3: Chamadas sequenciais confirmadas. Sem rajada paralela.');
    }, 30000);

    // ──────────────────────────────────────────────────────────────────────────
    it('TESTE 4: Limite de produtos por job é obrigatório (sem loop infinito)', async () => {
        mockVerificarQuota.mockResolvedValue(false);

        // Zera o delay para que o teste não esgote o timeout
        vi.spyOn(global, 'setTimeout').mockImplementation((fn: any) => { fn(); return 0 as any; });

        // Banco retorna sempre 5 produtos (nunca encerra — testa se o limite para o loop)
        const lote = linhasComMembros(5);
        mockQuery.mockResolvedValue({ rows: lote });

        await iniciarWorkerEExecutar();

        vi.restoreAllMocks();

        // Com o limite de 200 produtos ativos no código, o worker deve parar
        // Sem o limite, o while(true) correria infinitamente e o teste nunca terminaria
        const totalChamadas = mockDecompor.mock.calls.length;
        expect(totalChamadas).toBeLessThanOrEqual(200);
        expect(totalChamadas).toBeGreaterThan(0);
        console.log(`\n✅ TESTE 4: Worker processou ${totalChamadas} produtos e parou (limite ≤ 200). Sem loop infinito.`);
    }, 15000);


    // ──────────────────────────────────────────────────────────────────────────
    it('TESTE 5: Quota atingida no meio do job para tudo imediatamente', async () => {
        let chamadasGemini = 0;

        mockVerificarQuota
            .mockResolvedValueOnce(false) // verificação inicial: ok
            .mockResolvedValueOnce(false) // produto 1: ok
            .mockResolvedValueOnce(false) // produto 2: ok
            .mockResolvedValueOnce(true)  // produto 3: BLOQUEADO
            .mockResolvedValue(true);     // qualquer chamada após: bloqueado

        mockDecompor.mockImplementation(async () => {
            chamadasGemini++;
            return { membro_core: 'P', marca: null, especificacao: null, unidade_medida: null, metadados: null };
        });

        const rows = linhasComMembros(5);
        mockQuery
            .mockResolvedValueOnce({ rows })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValue({ rows: [] });

        await iniciarWorkerEExecutar();

        // Deve ter parado ANTES de processar todos os 5 produtos
        expect(chamadasGemini).toBeLessThan(5);
        expect(chamadasGemini).toBeGreaterThan(0);
        console.log(`\n✅ TESTE 5: Parou com ${chamadasGemini}/5 chamadas quando quota atingida. Custo protegido.`);
    });
});
