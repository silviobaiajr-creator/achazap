/**
 * Testes unitários — lógica crítica do sistema AchaZap.
 * Foco nas funções puras (sem dependências externas): merge, validação, índices.
 *
 * globals: true no vitest.config.ts — describe/it/expect disponíveis sem import.
 * Tipos resolvidos via src/vitest.d.ts.
 */
import { z } from 'zod';
import {
    ProdutoExtraidoSchema,
    NLPEscolhaSchema,
    parseSafe,
} from '../schemas.js';

// ─── nullSafe — Sprint 10 #3 ───────────────────────────────────────────────
// Testa a lógica de merge não-destrutivo (extraída para teste unitário)
function nullSafe<T>(novoValor: T | null | undefined, valorAntigo: T | null | undefined): T | null {
    if (novoValor !== null && novoValor !== undefined) return novoValor;
    return valorAntigo ?? null;
}

describe('nullSafe — merge não-destrutivo (Sprint 10 #3)', () => {
    it('deve usar o novo valor quando ele é um número positivo', () => {
        expect(nullSafe(15.0, 10.0)).toBe(15.0);
    });

    it('deve usar o novo valor quando ele é ZERO (bug crítico do ||)', () => {
        // O operador || trataria 0 como falsy e retornaria 10.0. nullSafe retorna 0.
        expect(nullSafe(0, 10.0)).toBe(0);
    });

    it('deve manter o valor antigo quando novo é null', () => {
        expect(nullSafe(null, 10.0)).toBe(10.0);
    });

    it('deve manter o valor antigo quando novo é undefined', () => {
        expect(nullSafe(undefined, 'Feijão')).toBe('Feijão');
    });

    it('deve retornar null se ambos forem null/undefined', () => {
        expect(nullSafe(null, undefined)).toBeNull();
    });
});

// ─── Zod Schemas — ProdutoExtraido ────────────────────────────────────────
describe('ProdutoExtraidoSchema — validação do output do Gemini', () => {
    it('deve aceitar produto completo', () => {
        const raw = JSON.stringify({ incompleto: false, ruido_detectado: false, nome: 'Feijão Preto', preco: 18.5, unidade: 'kg' });
        const result = parseSafe(ProdutoExtraidoSchema, raw, null as any);
        expect(result?.nome).toBe('Feijão Preto');
        expect(result?.preco).toBe(18.5);
    });

    it('deve aceitar ruído detectado', () => {
        const raw = JSON.stringify({ incompleto: false, ruido_detectado: true, nome: null, preco: null, unidade: null });
        const result = parseSafe(ProdutoExtraidoSchema, raw, null as any);
        expect(result?.ruido_detectado).toBe(true);
    });

    it('deve retornar fallback para JSON inválido', () => {
        const fallback = { incompleto: false, ruido_detectado: false, nome: null, preco: null, unidade: null };
        const result = parseSafe(ProdutoExtraidoSchema, 'não é json!!!', fallback);
        expect(result).toEqual(fallback);
    });

    it('deve truncar nome maior que 250 chars', () => {
        const nomeGigante = 'A'.repeat(300);
        const raw = JSON.stringify({ incompleto: false, ruido_detectado: false, nome: nomeGigante, preco: 10, unidade: 'un' });
        // O schema não trunca — a função processarDadosProduto faz o truncate.
        // O schema deve simplesmente falhar validation e acionar o fallback.
        const fallback = { incompleto: false, ruido_detectado: false, nome: null, preco: null, unidade: null };
        const result = parseSafe(ProdutoExtraidoSchema, raw, fallback);
        // nome > 250 → Zod rejeita → fallback
        expect(result?.nome).toBeNull();
    });
});

// ─── NLPEscolhaSchema ────────────────────────────────────────────────────
describe('NLPEscolhaSchema — NLP de escolha de similar', () => {
    it('deve aceitar escolha numérica', () => {
        const raw = JSON.stringify({ escolha: 2, cancelar: false });
        const result = parseSafe(NLPEscolhaSchema, raw, { escolha: -1, cancelar: true });
        expect(result.escolha).toBe(2);
        expect(result.cancelar).toBe(false);
    });

    it('deve aceitar cancelamento', () => {
        const raw = JSON.stringify({ escolha: 0, cancelar: true });
        const result = parseSafe(NLPEscolhaSchema, raw, { escolha: -1, cancelar: true });
        expect(result.cancelar).toBe(true);
    });

    it('deve retornar fallback seguro para JSON inválido', () => {
        const result = parseSafe(NLPEscolhaSchema, '{}', { escolha: -1, cancelar: true });
        // {} não tem escolha → coerced para -1 (fallback)
        expect(result.cancelar).toBe(true);
    });
});

// ─── parseSafe — helper de parse resiliente ───────────────────────────────
describe('parseSafe — helper de parse resiliente', () => {
    const Schema = z.object({ valor: z.number() });

    it('deve retornar o valor parseado se JSON válido', () => {
        expect(parseSafe(Schema, '{"valor": 42}', { valor: 0 })).toEqual({ valor: 42 });
    });

    it('deve retornar o fallback se JSON malformado', () => {
        expect(parseSafe(Schema, '{valor: 42}', { valor: 0 })).toEqual({ valor: 0 });
    });

    it('deve retornar o fallback se schema não bater', () => {
        expect(parseSafe(Schema, '{"valor": "texto"}', { valor: 0 })).toEqual({ valor: 0 });
    });
});
