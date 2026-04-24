/**
 * src/ai/__tests__/revisor-e2e.test.ts
 * Teste rigoroso End-to-End para o fluxo de Revisão de Preços usando Vitest.
 * 
 * Execução: npx vitest run src/ai/__tests__/revisor-e2e.test.ts
 */

import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// ── MOCKS ────────────────────────────────────────────────────────────────────
let sentMessages: string[] = [];

vi.mock('../../lib/whatsapp.js', async (importOriginal) => {
    return {
        ...await importOriginal<typeof import('../../lib/whatsapp.js')>(),
        sendTextMessage: async (to: string, text: string) => { sentMessages.push(`[TEXT] ${text}`); },
        sendInteractiveButtons: async (to: string, text: string) => { sentMessages.push(`[BTN] ${text}`); },
        sendListMessage: async (to: string, text: string) => { sentMessages.push(`[LIST] ${text}`); },
        sendReaction: async () => {},
        downloadMedia: async () => Buffer.from(''),
        sendCTAUrlMessage: async () => {},
    };
});

// Importações REAIS (após o mock)
import { supabaseAdmin as supabase } from '../../lib/supabase.js';
import { processMessage } from '../orchestrator.js';
import { processarRevisaoPrecos } from '../skills/revisor.js';
import { cache, limparContexto } from '../../lib/redis-cloud.js';

// ── DADOS DO TESTE ──────────────────────────────────────────────────────────
const TEST_PHONE = '5591999999999'; 
const TEST_WHATSAPP = `+${TEST_PHONE}`;

let lojaId = '';
let prodIds: string[] = [];

// ── UTILITÁRIOS ─────────────────────────────────────────────────────────────
function makeMsg(type: string, text?: string, buttonId?: string): any {
    return {
        from: TEST_PHONE,
        id: `msg_test_${Date.now()}`,
        type,
        text: text ? { body: text } : undefined,
        interactive: buttonId ? {
            button_reply: { id: buttonId, title: buttonId },
        } : undefined,
    };
}

async function delay(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function setupDB() {
    const { data: loja, error } = await supabase.from('lojas').upsert({
        whatsapp: TEST_WHATSAPP,
        nome: 'Supermercado Teste E2E',
        cidade: 'Mock City',
        bairro: 'Centro',
        estado: 'PA',
        categoria: 'supermercado',
        ativa: true,
        saldo_cliques: 1000,
    }, { onConflict: 'whatsapp' }).select('id').single();

    if (error) {
        console.error('ERRO AO CRIAR LOJA:', error);
        throw error;
    }

    lojaId = loja!.id;
}

async function resetProducts(dias: number) {
    await supabase.from('catalogo_ativo').delete().eq('loja_id', lojaId);
    
    const dataAlvo = new Date();
    dataAlvo.setDate(dataAlvo.getDate() - dias);
    
    const produtos = [
        { loja_id: lojaId, produto_nome: 'Arroz Teste 5kg', preco: 25.00, unidade: 'pc', disponivel: true, atualizado_em: dataAlvo.toISOString() },
        { loja_id: lojaId, produto_nome: 'Feijão Teste 1kg', preco: 8.00, unidade: 'pc', disponivel: true, atualizado_em: dataAlvo.toISOString() },
        { loja_id: lojaId, produto_nome: 'Macarrão Teste 500g', preco: 4.50, unidade: 'pc', disponivel: true, atualizado_em: dataAlvo.toISOString() },
    ];

    const { data: insertedProds, error } = await supabase.from('catalogo_ativo').upsert(produtos, { onConflict: 'loja_id, produto_nome' }).select('id');
    if (error) {
        console.error('ERRO AO INSERIR PRODUTOS DE TESTE:', error);
        throw error;
    }
    prodIds = insertedProds!.map(p => p.id);
}

async function teardownDB() {
    if (prodIds.length > 0) await supabase.from('catalogo_ativo').delete().in('id', prodIds);
    if (lojaId) await supabase.from('lojas').delete().eq('id', lojaId);
    await limparContexto(TEST_PHONE);
    cache.delete(`loja:${TEST_PHONE}`);
}

function getLatestMessage() { return sentMessages.join(' | '); }

// ── SUÍTE DE TESTES ──────────────────────────────────────────────────────────

describe('Revisor de Preços - Bateria Caótica (E2E)', () => {
    beforeAll(async () => {
        await setupDB();
    });

    afterAll(async () => {
        await teardownDB();
    });

    beforeEach(async () => {
        sentMessages = [];
        await limparContexto(TEST_PHONE);
        cache.delete(`loja:${TEST_PHONE}`);
        await resetProducts(10); 
    });

    it('Cenário 1: Happy Path - Tudo Verdinho', async () => {
        await resetProducts(0); // sobrescreve: atualizados hoje
        await processMessage(makeMsg('interactive', undefined, 'menu_revisar'));
        
        const resp = getLatestMessage();
        expect(resp).toContain('Tudo verdinho');
        // Bot envia: "Envie a palavra *Menu* para voltar às opções."
        expect(resp).toMatch(/envie|voltar|menu/i);
    });

    it('Cenário 2: Fuga Segura (Escape Hatch com 0)', async () => {
        await processMessage(makeMsg('interactive', undefined, 'menu_revisar'));
        expect(getLatestMessage()).toContain('Relatório de Vencimento');
        
        sentMessages = [];
        await processMessage(makeMsg('text', '0')); // Usuário desiste e digita 0
        
        const resp = getLatestMessage();
        expect(resp).toMatch(/cancelad[ao]/i); // bot responde "Revisão cancelada."
        expect(cache.get(`contexto:${TEST_PHONE}`)).toBeFalsy(); // null ou undefined = contexto apagado
    });

    it('Cenário 3: Múltiplos Itens (Power User)', async () => {
        await processMessage(makeMsg('interactive', undefined, 'menu_revisar'));
        
        sentMessages = [];
        await processMessage(makeMsg('text', '1 26,00 \n 2 9,00'));
        await delay(2000); 
        
        const resp = getLatestMessage();
        expect(resp).toMatch(/atualizado/i);
        
        const { data } = await supabase.from('catalogo_ativo').select('preco').eq('produto_nome', 'Arroz Teste 5kg').single();
        expect(data?.preco).toBe(26.00);
    });

    it('Cenário 4: Conclusão do Loop', async () => {
        await supabase.from('catalogo_ativo').delete().in('id', [prodIds[1]!, prodIds[2]!]);
        
        await processMessage(makeMsg('interactive', undefined, 'menu_revisar'));
        
        sentMessages = [];
        await processMessage(makeMsg('text', '1 30,00'));
        await delay(2000);
        
        const resp = getLatestMessage();
        expect(resp).toMatch(/verdinho|Obrigado|atualizado/i);
    });

    it('Cenário 5: Erro de Digitação Crasso (Letra "O")', async () => {
        await processMessage(makeMsg('interactive', undefined, 'menu_revisar'));
        
        sentMessages = [];
        await processMessage(makeMsg('text', '1 26,O0')); // letra O
        await delay(1000);
        
        const resp = getLatestMessage();
        expect(resp).not.toContain('atualizado');
        expect(resp).toMatch(/cancelar|cancelado|Exemplo/i);
    });

    it('Cenário 6: Esquecimento do Índice', async () => {
        await processMessage(makeMsg('interactive', undefined, 'menu_revisar'));
        
        sentMessages = [];
        await processMessage(makeMsg('text', '26,00')); // sem índice
        await delay(1000);
        
        const resp = getLatestMessage();
        expect(resp).not.toContain('atualizado');
        expect(resp).toMatch(/Exemplo|número e o novo/i);
    });

    it('Cenário 7: Índice Fora dos Limites', async () => {
        await processMessage(makeMsg('interactive', undefined, 'menu_revisar'));
        
        sentMessages = [];
        await processMessage(makeMsg('text', '9 50,00')); // só tem 3 itens
        await delay(1000);
        
        const resp = getLatestMessage();
        expect(resp).not.toContain('atualizado');
    });

    it('Cenário 8: Resposta em Áudio ou Foto', async () => {
        await processMessage(makeMsg('interactive', undefined, 'menu_revisar'));
        
        sentMessages = [];
        await processMessage(makeMsg('audio', undefined));
        
        const resp = getLatestMessage();
        expect(resp).toMatch(/digite|texto|cancelar/i);
    });

    it('Cenário 9: Preço Absurdo', async () => {
        await processMessage(makeMsg('interactive', undefined, 'menu_revisar'));
        
        sentMessages = [];
        await processMessage(makeMsg('text', '1 250000')); // Sem vírgula
        await delay(1000);
        
        const resp = getLatestMessage();
        expect(resp).not.toContain('atualizados');
        expect(resp).toMatch(/alto demais|seguran|verifique/i);
    });

    it('Cenário 10: Lojista Fantasma (Timeout)', async () => {
        await processMessage(makeMsg('interactive', undefined, 'menu_revisar'));
        
        cache.delete(`contexto:${TEST_PHONE}`); // timeout
        
        sentMessages = [];
        await processMessage(makeMsg('text', '1 26,00')); 
        await delay(1000);
        
        const resp = getLatestMessage();
        expect(resp).not.toContain('preço(s) atualizado(s)');
    });

    it('Cenário 11: Preservação de Data no Loop Parcial', async () => {
        // Simula 2 produtos bem velhos (10 dias)
        await resetProducts(10);
        await processarRevisaoPrecos(TEST_PHONE, { id: lojaId, nome: 'Loja Teste' });
        
        // Verifica que o relatório inicial mostra "há 10 dias"
        expect(getLatestMessage()).toMatch(/há 10 dias/i);
        
        // Atualiza apenas o item 1
        sentMessages = [];
        // Precisamos setar o contexto manualmente ou via processMessage
        // Vou usar o processMessage para ser fiel ao fluxo real
        await processMessage(makeMsg('interactive', undefined, 'menu_revisar'));
        sentMessages = [];
        await processMessage(makeMsg('text', '1 50,00'));
        await delay(1000);
        
        const resp = getLatestMessage();
        expect(resp).toContain('Preços atualizados');
        expect(resp).toContain('Ainda pendentes');
        // BUG FIX CHECK: Não deve dizer "Sem data" para o item que sobrou
        expect(resp).not.toContain('Sem data');
        expect(resp).not.toContain('Sem data');
        expect(resp).toMatch(/há 10 dias/i); // Deve manter a info original
    });
});
