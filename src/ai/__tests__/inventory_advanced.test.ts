// Mock das variáveis de ambiente ANTES de qualquer import
process.env.WHATSAPP_VERIFY_TOKEN = 'test';
process.env.GEMINI_API_KEY = 'test';
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'test';
process.env.DATABASE_URL = 'postgresql://test';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleInventory } from '../agents/inventory-agent.js';
import { handleRevisor } from '../agents/revisor-agent.js';
import { EstadosFluxo } from '../types.js';
import * as whatsapp from '../../lib/whatsapp.js';
import * as redis from '../../lib/redis-cloud.js';
import * as ledger from '../skills/catalog-ledger.js';

// Mock das dependências
vi.mock('../../lib/whatsapp.js');
vi.mock('../../lib/redis-cloud.js');
vi.mock('../../lib/gemini.js');
vi.mock('../skills/catalog-ledger.js', () => ({
    buscarProdutosSimilares: vi.fn().mockResolvedValue([]),
    ingeriCatalogo: vi.fn().mockResolvedValue({ inserido: true }),
    atualizarPrecoLedger: vi.fn().mockResolvedValue(true),
    buscarSimilaresSemanticoRaw: vi.fn().mockResolvedValue([])
}));
vi.mock('../../config.js', () => ({
    env: {
        WHATSAPP_TOKEN: 'test',
        WHATSAPP_VERIFY_TOKEN: 'test',
        GEMINI_API_KEY: 'test',
        SUPABASE_URL: 'https://test.supabase.co',
        SUPABASE_SECRET_KEY: 'test',
        DATABASE_URL: 'postgresql://test',
    }
}));

const FROM = '5511999999999';
const LOJA = { id: 'loja_123', nome: 'Mercado Teste' };

describe('Inventory Advanced Interaction Flows', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    /**
     * CENÁRIO: Ambuidade (O lojista envia um produto que tem similares no estoque)
     */
    it('Fluxo de Ambuidade: deve permitir escolher entre similares ou novo cadastro', async () => {
        const contexto = {
            estado: EstadosFluxo.AGUARDANDO_ACAO_SIMILARES,
            dadosProduto: { nome: 'Coca Cola 2L', preco: 10.0, unidade: 'un' },
            similaresEncontrados: [
                { id: '1', produto_nome: 'Coca Cola 2L Retornável', preco: 8.0, unidade: 'un' },
                { id: '2', produto_nome: 'Coca Cola 2L Normal', preco: 9.0, unidade: 'un' }
            ]
        };

        const mockReprocess = vi.fn();
        const consumed = await handleInventory(
            { from: FROM, type: 'text', text: { body: '1' } } as any,
            FROM,
            LOJA,
            contexto as any,
            '1',
            '',
            false,
            true,
            false,
            mockReprocess
        );

        expect(consumed).toBe(true);
        expect(redis.salvarContexto).toHaveBeenCalledWith(FROM, expect.objectContaining({
            estado: EstadosFluxo.AGUARDANDO_ACAO_PRODUTO_SELECIONADO,
            dadosProduto: expect.objectContaining({ nome: 'Coca Cola 2L Retornável' })
        }));
    });

    /**
     * CENÁRIO: Embalagem Coletiva (Fardo/Caixa)
     */
    it('Fluxo de Embalagem: deve perguntar quantidade se detectar fardo/caixa sem número', async () => {
        const contexto = {
            estado: EstadosFluxo.AGUARDANDO_QUANTIDADE_EMBALAGEM,
            dadosProduto: { nome: 'Fardo de Coca', preco: 50.0, unidade: 'un' }
        };

        const mockReprocess = vi.fn();
        const consumed = await handleInventory(
            { from: FROM, type: 'text', text: { body: '24 unidades' } } as any,
            FROM,
            LOJA,
            contexto as any,
            '24 unidades',
            '',
            false,
            true,
            false,
            mockReprocess
        );

        expect(consumed).toBe(true);
        expect(redis.salvarContexto).toHaveBeenCalledWith(FROM, expect.objectContaining({
            dadosProduto: expect.objectContaining({ nome: 'Fardo de Coca (24 unidades)' })
        }));
    });

    /**
     * CENÁRIO: Revisão de Preços (Fluxo Completo)
     */
    it('Fluxo de Revisão: deve permitir atualizar itens um por um na lista de revisão', async () => {
        const contexto = {
            estado: EstadosFluxo.AGUARDANDO_SELECAO_REVISAO,
            alteracoesPlanejadas: [
                { nome: 'Leite', precoFoto: 5.0, unidade: 'un' },
                { nome: 'Arroz', precoFoto: 20.0, unidade: 'kg', dataReferencia: new Date().toISOString() }
            ],
            revisaoIndice: 0
        };

        const consumed = await handleRevisor(
            { from: FROM, type: 'interactive', interactive: { button_reply: { id: 'btn_revisar_manter' } } } as any,
            FROM,
            LOJA,
            contexto as any,
            '',
            'btn_revisar_manter',
            true,
            false,
            false
        );

        expect(consumed).toBe(true);
        expect(redis.salvarContexto).toHaveBeenCalledWith(FROM, expect.objectContaining({
            revisaoIndice: 1
        }));
    });

    /**
     * CENÁRIO: Sugestão Ortográfica
     */
    it('Sugestão Ortográfica: deve aceitar "Sim" para correção de nome', async () => {
        const contexto = {
            estado: EstadosFluxo.AGUARDANDO_CONFIRMACAO_NOME,
            dadosProduto: { nome: 'Leite Ninho', preco: 15.0, unidade: 'un' }
        };

        const mockReprocess = vi.fn();
        const consumed = await handleInventory(
            { from: FROM, type: 'interactive', interactive: { button_reply: { id: 'btn_sugestao_sim' } } } as any,
            FROM,
            LOJA,
            contexto as any,
            '',
            'btn_sugestao_sim',
            true,
            false,
            false,
            mockReprocess
        );

        expect(consumed).toBe(true);
        expect(whatsapp.sendTextMessage).toHaveBeenCalledWith(FROM, expect.stringContaining('Ótimo, ajustado'));
    });
});
