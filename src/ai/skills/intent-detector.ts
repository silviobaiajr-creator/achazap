/**
 * Skill: intent-detector
 * Responsabilidade: Detecção de intenção via IA (fuga e cadastro proativo).
 * Mantém as chamadas Gemini isoladas do loop de roteamento principal.
 */

import { ai, GEMINI_MODEL } from '../../lib/gemini.js';
import { logTokens } from '../../lib/logger.js';
import { FugaNLPSchema, parseSafe } from '../schemas.js';
import { z } from 'zod';

/**
 * Detecta se o texto indica intenção de sair/cancelar o fluxo atual.
 * Usa NLP para capturar frases coloquiais que o regex não pega.
 */
export async function detectarFugaNLP(texto: string): Promise<boolean> {
    try {
        const result = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: `Analise se a seguinte frase indica uma intenção global de encerrar ou sair de um fluxo de cadastro de produtos num sistema de estoque. NÃO confunda com nomes de produto (ex: "Apaga" pode ser uma borracha). Retorne APENAS o JSON: {"intencao_fuga": boolean}\n\nFrase: "${texto}"\n\nJSON:`,
            config: { responseMimeType: 'application/json' },
        });
        logTokens('detectar_fuga_nlp', 'system', 'system', result.usageMetadata);
        const dados = parseSafe(FugaNLPSchema, result.text || '{}', { intencao_fuga: false });
        return dados.intencao_fuga === true;
    } catch {
        return false;
    }
}

/**
 * Detecta se o texto em estado IDLE indica intenção de cadastrar um produto.
 * Evita desperdício de tokens para saudações e mensagens genéricas.
 */
export async function detectarIntencaoProativa(texto: string): Promise<boolean> {
    try {
        const result = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: `Analise se o usuário está tentando cadastrar um produto no estoque ou apenas conversando/dando oi. 
            Se a mensagem for simplesmente o NOME de um produto (ex: "Acem", "Arroz", "Cerveja") ou contiver preço (ex: "Lança aí: Leite 4.50"), é cadastro.
            Se for saudação ou pergunta genérica (ex: "Oi", "Como funciona?"), não é cadastro.
            Retorne APENAS o JSON: {"intencao_cadastro": boolean}\n\nFrase: "${texto}"\n\nJSON:`,
            config: { responseMimeType: 'application/json' },
        });
        logTokens('detectar_intencao_proativa', 'system', 'system', result.usageMetadata);
        const dados = parseSafe(z.object({ intencao_cadastro: z.boolean() }), result.text || '{}', { intencao_cadastro: false });
        return dados.intencao_cadastro === true;
    } catch {
        return false;
    }
}
