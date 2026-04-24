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
let lojaId = '';
let currentPhone = '';
let currentWhatsApp = '';
let prodIds: string[] = [];

// ── UTILITÁRIOS ─────────────────────────────────────────────────────────────
function makeMsg(type: string, text?: string, buttonId?: string): any {
    return {
        from: currentPhone,
        id: `msg_test_${Date.now()}`,
        type,
        text: text ? { body: text } : undefined,
        interactive: buttonId ? {
            button_reply: { id: buttonId, title: buttonId },
        } : undefined,
    };
}

async function delay(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function setupDB(phone: string) {
    const whatsapp = `+${phone}`;
    const { data: loja, error } = await supabase.from('lojas').upsert({
        whatsapp: whatsapp,
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

async function resetProducts(dias: number, count = 3) {
    await supabase.from('catalogo_ativo').delete().eq('loja_id', lojaId);
    
    const dataAlvo = new Date();
    dataAlvo.setDate(dataAlvo.getDate() - dias);
    
    const nomesPadrao = ['Arroz Teste 5kg', 'Feijão Teste 1kg', 'Macarrão Teste 500g'];
    const produtos = [];
    for (let i = 0; i < count; i++) {
        produtos.push({ 
            loja_id: lojaId, 
            produto_nome: nomesPadrao[i] || `Produto Extra ${i+1}`, 
            preco: (i + 1) * 10, 
            unidade: 'pc', 
            disponivel: true, 
            atualizado_em: dataAlvo.toISOString() 
        });
    }

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
    await limparContexto(currentPhone);
    cache.delete(`loja:${currentPhone}`);
}

function getLatestMessage() { return sentMessages.join(' | '); }

// ── SUÍTE DE TESTES ──────────────────────────────────────────────────────────

describe('Revisor de Preços - Bateria Caótica (E2E)', () => {
    beforeEach(async () => {
        sentMessages = [];
        currentPhone = `5591${Math.floor(100000000 + Math.random() * 900000000)}`;
        currentWhatsApp = `+${currentPhone}`;
        
        await setupDB(currentPhone);
        await limparContexto(currentPhone);
        cache.delete(`loja:${currentPhone}`);
        await resetProducts(10); 
        await delay(500);
    });

    afterEach(async () => {
        await teardownDB();
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
        expect(cache.get(`contexto:${currentPhone}`)).toBeFalsy(); // null ou undefined = contexto apagado
    });

    it('Cenário 3: Múltiplos Itens (Power User)', async () => {
        await processMessage(makeMsg('interactive', undefined, 'menu_revisar'));
        
        sentMessages = [];
        await processMessage(makeMsg('text', '1 26,00 \n 2 9,00'));
        await delay(2000); 
        
        const resp = getLatestMessage();
        expect(resp).toMatch(/atualizado/i);
        const { data } = await supabase.from('catalogo_ativo').select('produto_nome, preco').eq('loja_id', lojaId).eq('produto_nome', 'Arroz Teste 5kg').single();
        if (!data) throw new Error('Produto Arroz Teste 5kg não encontrado após update');
        expect(data.preco, `Produto: ${data.produto_nome}`).toBe(26.00);
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
        expect(resp).toMatch(/Revisão em andamento/i);
        expect(resp).toContain('Ainda pendentes');
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
        
        cache.delete(`contexto:${currentPhone}`); // timeout
        
        sentMessages = [];
        await processMessage(makeMsg('text', '1 26,00')); 
        await delay(1000);
        
        const resp = getLatestMessage();
        expect(resp).not.toContain('preço(s) atualizado(s)');
    });

    it('Cenário 11: Preservação de Data no Loop Parcial', async () => {
        // Simula 2 produtos bem velhos (10 dias)
        await resetProducts(10);
        await processarRevisaoPrecos(currentPhone, { id: lojaId, nome: 'Loja Teste' });
        
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
        expect(resp).toContain('Progresso');
        expect(resp).toContain('Ainda pendentes');
        // BUG FIX CHECK: Não deve dizer "Sem data" para o item que sobrou
        expect(resp).not.toContain('Sem data');
        expect(resp).not.toContain('Sem data');
        expect(resp).toMatch(/há 10 dias/i); // Deve manter a info original
    });
    it('Cenário 12: Contador de Progresso Cumulativo', async () => {
        // Simula 4 produtos velhos
        await resetProducts(10, 4); 

        await processMessage(makeMsg('interactive', undefined, 'menu_revisar'));
        
        // Passo 1: Atualiza 2 itens
        sentMessages = [];
        await processMessage(makeMsg('text', '1 10,00 2 20,00'));
        let resp = getLatestMessage();
        expect(resp).toMatch(/Progresso:.*2 de 4/i);
        
        // Passo 2: Atualiza mais 1 item (que agora é o índice 1 na nova lista de 2 pendentes)
        sentMessages = [];
        await processMessage(makeMsg('text', '1 30,00'));
        resp = getLatestMessage();
        // BUG FIX CHECK: Deve mostrar 3 de 4
        expect(resp).toMatch(/Progresso:.*3 de 4/i);
        expect(resp).toContain('Ainda pendentes');
    });

    it('Cenário 13: Detecção de Índices Repetidos', async () => {
        await resetProducts(10, 3);
        await processMessage(makeMsg('interactive', undefined, 'menu_revisar'));
        
        sentMessages = [];
        await processMessage(makeMsg('text', '1 10,00 1 15,00')); // Repetido
        const resp = getLatestMessage();
        expect(resp).toContain('lançou preços diferentes para o mesmo item');
    });

    it('Cenário 14: Suporte a Ponto de Milhar', async () => {
        await resetProducts(10, 3);
        await processMessage(makeMsg('interactive', undefined, 'menu_revisar'));
        
        sentMessages = [];
        await processMessage(makeMsg('text', '1 1.250,50')); 
        const resp = getLatestMessage();
        expect(resp).toMatch(/Progresso:.*1 de 3/i);
        
        const { data } = await supabase.from('catalogo_ativo').select('preco').eq('loja_id', lojaId).eq('produto_nome', 'Arroz Teste 5kg').single();
        expect(data?.preco).toBe(1250.50);
    });

    it('Cenário 15: Continuidade de Grandes Lotes', async () => {
        // Simula 10 produtos velhos (o bot mostra 8 por vez)
        await resetProducts(10, 10);
        await processMessage(makeMsg('interactive', undefined, 'menu_revisar'));
        
        // Deve mostrar 8 pendentes iniciais
        expect(getLatestMessage()).toMatch(/Relatório de Vencimento/i);
        
        // Atualiza os 8 primeiros
        sentMessages = [];
        await processMessage(makeMsg('text', '1 10 2 10 3 10 4 10 5 10 6 10 7 10 8 10'));
        
        let resp = getLatestMessage();
        expect(resp).toContain('Lote concluído com sucesso');
        
        // Espera o novo relatório
        await delay(2000);
        resp = getLatestMessage();
        expect(resp).toMatch(/Relatório de Vencimento/i);
        expect(resp).toMatch(/item\(s\) precisam de atenção/i);
    });
});
