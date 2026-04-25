import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleInventory } from '../agents/inventory-agent.js';
import { handleOnboarding } from '../agents/onboarding-agent.js';
import { EstadosFluxo } from '../types.js';

// ── Mocks de dependências externas ───────────────────────────────────────────
let sentMessages: string[] = [];
let savedContexts: Record<string, any> = {};

vi.mock('../../lib/whatsapp.js', () => ({
    sendTextMessage: vi.fn(async (to, text) => { sentMessages.push(`[TEXT] ${text}`); }),
    sendInteractiveButtons: vi.fn(async (to, text) => { sentMessages.push(`[BTNS] ${text}`); }),
    sendListMessage: vi.fn(async (to, text) => { sentMessages.push(`[LIST] ${text}`); }),
    sendReaction: vi.fn(),
    downloadMedia: vi.fn(),
    sendCTAUrlMessage: vi.fn(),
}));

vi.mock('../../lib/redis-cloud.js', () => ({
    salvarContexto: vi.fn(async (wa, ctx) => { savedContexts[wa] = ctx; }),
    lerContexto: vi.fn(async (wa) => savedContexts[wa] || null),
    limparContexto: vi.fn(async (wa) => { delete savedContexts[wa]; }),
    renovarTTLContexto: vi.fn(),
    cache: { get: () => null, set: () => {}, delete: () => {} },
}));

const mockChainable = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    upsert: vi.fn().mockResolvedValue({ data: null, error: null }),
};

vi.mock('../../lib/supabase.js', () => ({
    supabaseAdmin: {
        from: vi.fn(() => mockChainable),
    }
}));

vi.mock('../../lib/gemini.js', () => ({
    ai: {
        models: {
            generateContent: vi.fn().mockResolvedValue({
                text: JSON.stringify({ escolha: 1, cancelar: false }),
                usageMetadata: { totalTokenCount: 100 }
            }),
        }
    },
    GEMINI_MODEL: 'gemini-1.5-flash',
}));

describe('Smoke Test — Agentes da Fase 2', () => {
    const FROM = '5511999999999';
    const LOJA = { id: 'loja_123', nome: 'Loja Teste' };
    const mockReprocess = vi.fn();

    beforeEach(() => {
        sentMessages = [];
        savedContexts = {};
        vi.clearAllMocks();
        // Reset mocks chainables
        mockChainable.single.mockResolvedValue({ data: null, error: null });
        mockChainable.maybeSingle.mockResolvedValue({ data: null, error: null });
    });

    it('Scenario 1: InventoryAgent deve ignorar se estado for IDLE', async () => {
        const consumed = await handleInventory({ from: FROM, type: 'text', text: { body: 'Oi' } } as any, FROM, LOJA, { estado: EstadosFluxo.IDLE }, 'Oi', '', mockReprocess);
        expect(consumed).toBe(false);
    });

    it('Scenario 2: InventoryAgent deve consumir se estado for AGUARDANDO_DADOS_PRODUTO', async () => {
        const consumed = await handleInventory({ from: FROM, type: 'text', text: { body: 'Arroz 10' } } as any, FROM, LOJA, { estado: EstadosFluxo.AGUARDANDO_DADOS_PRODUTO }, 'Arroz 10', '', mockReprocess);
        expect(consumed).toBe(true);
    });

    it('Scenario 3: InventoryAgent deve consumir se estado for AGUARDANDO_ACAO_SIMILARES', async () => {
        const consumed = await handleInventory({ from: FROM, type: 'text', text: { body: '1' } } as any, FROM, LOJA, { estado: EstadosFluxo.AGUARDANDO_ACAO_SIMILARES, similaresEncontrados: [{}] }, '1', '', mockReprocess);
        expect(consumed).toBe(true);
    });

    it('Scenario 4: InventoryAgent deve consumir se estado for AGUARDANDO_ACAO_PRODUTO_SELECIONADO', async () => {
        const consumed = await handleInventory({ from: FROM, type: 'interactive', interactive: { button_reply: { id: 'acao_atualizar' } } } as any, FROM, LOJA, { estado: EstadosFluxo.AGUARDANDO_ACAO_PRODUTO_SELECIONADO, dadosProduto: { nome: 'X' } }, '', 'acao_atualizar', mockReprocess);
        expect(consumed).toBe(true);
    });

    it('Scenario 5: InventoryAgent deve consumir se estado for AGUARDANDO_CONFIRMACAO_ALTERACOES', async () => {
        const consumed = await handleInventory({ from: FROM, type: 'interactive', interactive: { button_reply: { id: 'confirmar_alteracoes_sim' } } } as any, FROM, LOJA, { estado: EstadosFluxo.AGUARDANDO_CONFIRMACAO_ALTERACOES }, '', 'confirmar_alteracoes_sim', mockReprocess);
        expect(consumed).toBe(true);
    });

    it('Scenario 6: InventoryAgent deve consumir se estado for AGUARDANDO_SELECAO_EDICAO', async () => {
        // Enviar '1' para o item de índice 0 (pois '1' é o label visual)
        const consumed = await handleInventory({ from: FROM, type: 'text', text: { body: '1' } } as any, FROM, LOJA, { estado: EstadosFluxo.AGUARDANDO_SELECAO_EDICAO, alteracoesPlanejadas: [{ nome: 'Item 1' }] }, '1', '', mockReprocess);
        expect(consumed).toBe(true);
    });

    it('Scenario 7: OnboardingAgent deve consumir se não houver loja nem contexto', async () => {
        const consumed = await handleOnboarding({ from: FROM, type: 'text', text: { body: 'Oi' } } as any, FROM, null, null, 'Oi', '', (l) => {});
        expect(consumed).toBe(true);
        expect(sentMessages[0]).toContain('AchaZap');
    });

    it('Scenario 8: OnboardingAgent deve ignorar se a loja já existir', async () => {
        const consumed = await handleOnboarding({ from: FROM, type: 'text', text: { body: 'Oi' } } as any, FROM, LOJA, { estado: EstadosFluxo.IDLE }, 'Oi', '', (l) => {});
        expect(consumed).toBe(false);
    });

    it('Scenario 9: OnboardingAgent deve consumir se estiver em ONBOARDING_NOME', async () => {
        const consumed = await handleOnboarding({ from: FROM, type: 'text', text: { body: 'Minha Loja' } } as any, FROM, null, { estado: EstadosFluxo.ONBOARDING_NOME }, 'Minha Loja', '', (l) => {});
        expect(consumed).toBe(true);
    });

    it('Scenario 10: InventoryAgent deve falhar graciosamente se dadosProduto sumirem', async () => {
        const consumed = await handleInventory({ from: FROM, type: 'interactive', interactive: { button_reply: { id: 'acao_atualizar' } } } as any, FROM, LOJA, { estado: EstadosFluxo.AGUARDANDO_ACAO_PRODUTO_SELECIONADO, dadosProduto: null }, '', 'acao_atualizar', mockReprocess);
        expect(consumed).toBe(true);
        expect(sentMessages[0]).toContain('Sessão expirada');
    });

    it('Scenario 11: InventoryAgent deve processar 0 (remover) no AGUARDANDO_NOVO_PRECO_EDICAO', async () => {
        const ctx = { estado: EstadosFluxo.AGUARDANDO_NOVO_PRECO_EDICAO, acao: '0', alteracoesPlanejadas: [{ nome: 'X', precoFoto: 10 }] };
        const consumed = await handleInventory({ from: FROM, type: 'text', text: { body: '0' } } as any, FROM, LOJA, ctx, '0', '', mockReprocess);
        expect(consumed).toBe(true);
        expect(sentMessages[0]).toContain('removeu todos os itens');
    });

    it('Scenario 12: OnboardingAgent deve ignorar se for consumidor cadastrado', async () => {
        mockChainable.maybeSingle.mockResolvedValueOnce({ data: { id: 'user_123' }, error: null });
        const consumed = await handleOnboarding({ from: FROM, type: 'text', text: { body: 'Oi' } } as any, FROM, null, null, 'Oi', '', (l) => {});
        expect(consumed).toBe(false);
    });
});
