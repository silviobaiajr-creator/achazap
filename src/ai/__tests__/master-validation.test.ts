import * as whatsapp from '../../lib/whatsapp.js';
import * as redis from '../../lib/redis-cloud.js';
import { supabaseAdmin as supabase } from '../../lib/supabase.js';
import { processMessage } from '../orchestrator.js';
import { EstadosFluxo, ContextoSessao } from '../types.js';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

/**
 * MASTER VALIDATION SCRIPT - ACHAZAP PHASE 2
 * Este script simula fluxos reais ponto-a-ponto para garantir que a refatoração
 * não quebrou a lógica de roteamento e processamento.
 */

// Mocks manuais para evitar efeitos colaterais
vi.mock('../../lib/whatsapp.js', () => ({
    sendTextMessage: vi.fn().mockResolvedValue({}),
    sendInteractiveButtons: vi.fn().mockResolvedValue({}),
    sendListMessage: vi.fn().mockResolvedValue({}),
    sendReaction: vi.fn().mockResolvedValue({}),
    downloadMedia: vi.fn().mockResolvedValue(Buffer.from('dummy')),
}));

// Memória persistente para o cache do Redis durante o teste
const memoryCache: Record<string, any> = {};

vi.mock('../../lib/redis-cloud.js', () => {
    return {
        lerContexto: vi.fn(async (from) => memoryCache[from] || null),
        salvarContexto: vi.fn(async (from, ctx) => { memoryCache[from] = ctx; }),
        limparContexto: vi.fn(async (from) => { delete memoryCache[from]; }),
        renovarTTLContexto: vi.fn(),
        adquirirLock: vi.fn(() => true),
        liberarLock: vi.fn(),
        cache: {
            get: vi.fn((key) => {
                // Se a memória cache tem algo, retorna. Se não, se for loja e não for teste de onboarding, retorna padrão.
                if (key.startsWith('loja:') && memoryCache['bypass_cache_loja']) return null;
                if (key.startsWith('loja:')) return { id: 'loja_123', nome: 'Loja Teste' };
                return null;
            }),
            set: vi.fn(),
        },
        incrementarBucketMidia: vi.fn(() => false),
        ttlBucketMidia: vi.fn(() => 0),
        temAvisoSpam: vi.fn(() => false),
        setAvisoSpam: vi.fn(),
    };
});

vi.mock('../../lib/supabase.js', () => {
    const chainable = {
        select: vi.fn().mockReturnThis(),
        insert: vi.fn().mockReturnThis(),
        update: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        not: vi.fn().mockReturnThis(),
        lt: vi.fn().mockReturnThis(),
        gte: vi.fn().mockReturnThis(),
        lte: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        single: vi.fn().mockResolvedValue({ data: { id: 'loja_123', nome: 'Loja Teste' }, error: null }),
        rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
        then: vi.fn(function(resolve) { return Promise.resolve(resolve({ data: [], error: null, count: 0 })); }),
    };
    return {
        supabaseAdmin: {
            from: vi.fn(() => chainable),
            rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
        }
    };
});

// Mock do Gemini para respostas previsíveis
vi.mock('../../lib/gemini.js', () => ({
    ai: {
        models: {
            generateContent: vi.fn(async ({ contents }) => {
                const text = contents.toString().toLowerCase();
                // Simula extração de produto
                if (text.includes('extraia') || text.includes('produto')) {
                    return {
                        text: JSON.stringify({
                            ruido_detectado: false,
                            nome: "Cerveja Heineken",
                            preco: 9.90,
                            unidade: "lata"
                        }),
                        usageMetadata: { totalTokenCount: 100 }
                    };
                }
                // Simula detecção de intenção proativa
                if (text.includes('intenção proativa')) {
                    return { text: "true", usageMetadata: { totalTokenCount: 10 } };
                }
                return { text: "{}", usageMetadata: { totalTokenCount: 5 } };
            })
        }
    },
    GEMINI_MODEL: 'gemini-2.0-flash'
}));

// Mock das skills para evitar DB real
vi.mock('../skills/catalog-ledger.js', () => ({
    buscarProdutosSimilares: vi.fn().mockResolvedValue([]),
    ingeriCatalogo: vi.fn().mockResolvedValue({ inserido: true }),
    atualizarPrecoLedger: vi.fn().mockResolvedValue({ success: true }),
    retirarEstoqueLedger: vi.fn().mockResolvedValue({ success: true }),
    gerarEmbedding: vi.fn().mockResolvedValue([0.1, 0.2]),
}));

vi.mock('../skills/intent-detector.js', () => ({
    detectarFugaNLP: vi.fn().mockResolvedValue(false),
    detectarIntencaoProativa: vi.fn().mockResolvedValue(true),
    extrairListaCompras: vi.fn().mockResolvedValue([{ item: 'leite' }]),
    refinarCandidatosBusca: vi.fn().mockResolvedValue(null),
}));

describe('Master Validation - Achazap Phase 2 Refactoring', () => {
    const FROM = '5511999999999';

    beforeEach(async () => {
        vi.clearAllMocks();
        // Limpar memória do cache
        for (const key in memoryCache) delete memoryCache[key];
    });

    it('Fluxo 1: Deve encaminhar para Onboarding se a loja não existir', async () => {
        // Simula loja não encontrada no cache e no banco
        memoryCache['bypass_cache_loja'] = true;
        const mockFrom = (supabase.from as any)();
        mockFrom.single.mockResolvedValue({ data: null, error: null });
        // Também mockar o maybeSingle por precaução
        mockFrom.maybeSingle.mockResolvedValue({ data: null, error: null });

        await processMessage({
            from: FROM,
            type: 'text',
            text: { body: 'Olá' },
            timestamp: Date.now().toString()
        } as any);

        // Deve ter iniciado o onboarding (pedindo nome ou perfil via botões interativos)
        expect(whatsapp.sendInteractiveButtons).toHaveBeenCalledWith(FROM, expect.stringMatching(/AchaZap.*assistente/i), expect.any(Array));
    });

    it('Fluxo 2: Deve delegar para InventoryAgent em estado AGUARDANDO_DADOS_PRODUTO', async () => {
        // Simula contexto ativo de inventário via memória real do mock
        await redis.salvarContexto(FROM, {
            estado: EstadosFluxo.AGUARDANDO_DADOS_PRODUTO,
            acao: 'cadastrar'
        });

        await processMessage({
            from: FROM,
            type: 'text',
            text: { body: 'Arroz 25.00' },
            timestamp: Date.now().toString()
        } as any);

        // Deve ter chamado o Gemini para extrair e depois salvo no catálogo (ou buscado similares)
        // Como o mock de similares retorna vazio, ele deve inserir direto.
        expect(whatsapp.sendTextMessage).toHaveBeenCalledWith(FROM, expect.stringContaining('cadastrado com sucesso'));
    });

    it('Fluxo 3: Deve processar múltiplos produtos (lote) via InventoryAgent', async () => {
        await redis.salvarContexto(FROM, {
            estado: EstadosFluxo.AGUARDANDO_DADOS_PRODUTO,
            acao: 'cadastrar'
        });

        // Mock Gemini retornando múltiplos
        const { ai } = await import('../../lib/gemini.js');
        (ai.models.generateContent as any).mockResolvedValueOnce({
            text: JSON.stringify({
                ruido_detectado: false,
                itens: [
                    { nome: "Coca", preco: 5.0, unidade: "un" },
                    { nome: "Pepsi", preco: 4.5, unidade: "un" }
                ]
            }),
            usageMetadata: { totalTokenCount: 200 }
        });

        await processMessage({
            from: FROM,
            type: 'text',
            text: { body: 'Coca 5, Pepsi 4.5' },
            timestamp: Date.now().toString()
        } as any);

        // Deve mostrar o resumo em lote (2 produtos)
        expect(whatsapp.sendTextMessage).toHaveBeenCalledWith(FROM, expect.stringContaining('Resumo — 2 produto(s)'));
        expect(whatsapp.sendInteractiveButtons).toHaveBeenCalledWith(FROM, expect.stringContaining('Confirma as alterações'), expect.any(Array));
    });

    it('Fluxo 4: Deve respeitar a Fuga Global mesmo dentro do InventoryAgent', async () => {
        await redis.salvarContexto(FROM, {
            estado: EstadosFluxo.AGUARDANDO_DADOS_PRODUTO,
            acao: 'cadastrar'
        });

        await processMessage({
            from: FROM,
            type: 'text',
            text: { body: 'cancelar' },
            timestamp: Date.now().toString()
        } as any);

        // Deve limpar contexto e avisar cancelamento
        expect(redis.limparContexto).toHaveBeenCalledWith(FROM);
        expect(whatsapp.sendTextMessage).toHaveBeenCalledWith(FROM, expect.stringContaining('cancelada'));
    });

    it('Fluxo 5: Deve tratar o estado AGUARDANDO_SELECAO_REVISAO (que ficou no orchestrator)', async () => {
        await redis.salvarContexto(FROM, {
            estado: EstadosFluxo.AGUARDANDO_SELECAO_REVISAO,
            alteracoesPlanejadas: [
                { nome: 'Produto A', precoFoto: 10, unidade: 'un', dataReferencia: new Date().toISOString(), acao: 'ambiguo' }
            ],
            totalItensRevisao: 1
        });

        await processMessage({
            from: FROM,
            type: 'text',
            text: { body: '1 12.50' },
            timestamp: Date.now().toString()
        } as any);

        // Deve atualizar o ledger e finalizar (primeira chamada do progresso)
        expect(whatsapp.sendTextMessage).toHaveBeenCalledWith(FROM, expect.stringMatching(/Progresso.*1 de 1/i));
        
        // E a segunda chamada deve ser o "Tudo verdinho" (ou o que a skill retornar agora que o mock funciona)
        expect(whatsapp.sendTextMessage).toHaveBeenLastCalledWith(FROM, expect.stringMatching(/Tudo verdinho|vencimento/i));
    });

    it('Fluxo 6: Deve processar mídia proativa em IDLE via orchestrator -> skill', async () => {
        (redis.lerContexto as any).mockResolvedValueOnce(null); // IDLE

        await processMessage({
            from: FROM,
            type: 'image',
            image: { id: 'img_123', file_size: 50000 },
            timestamp: Date.now().toString()
        } as any);

        // Deve adquirir lock e iniciar processamento de mídia
        expect(redis.adquirirLock).toHaveBeenCalled();
        // Nota: processarMidia é uma skill importada, o orchestrator deve chamá-la.
        // Aqui verificamos se não houve erro e o lock foi pedido.
    });

    it('Fluxo 7: Deve funcionar o reprocessFn para NLP de seleção de edição', async () => {
        // Estado: Lojista escolhe qual item editar da lista
        await redis.salvarContexto(FROM, {
            estado: EstadosFluxo.AGUARDANDO_SELECAO_EDICAO,
            alteracoesPlanejadas: [
                { nome: 'Leite Ninho', precoFoto: 10, unidade: 'un', acao: 'novo_cadastro' }
            ]
        });

        // Simula Gemini identificando o nome "Leite" como escolha 1
        const { ai } = await import('../../lib/gemini.js');
        (ai.models.generateContent as any).mockResolvedValueOnce({
            text: JSON.stringify({ escolha: 1, cancelar: false }),
            usageMetadata: { totalTokenCount: 100 }
        });

        await processMessage({
            from: FROM,
            type: 'text',
            text: { body: 'quero editar o leite' },
            timestamp: Date.now().toString()
        } as any);

        // O reprocessFn deve ter sido disparado injetando o texto "1"
        // Como o reprocessFn é o próprio processMessage (recursão),
        // ele deve eventualmente mostrar as opções de edição do item 1.
        expect(whatsapp.sendInteractiveButtons).toHaveBeenLastCalledWith(FROM, expect.stringMatching(/Item: \*Leite Ninho\*/), expect.any(Array));
    });
});
