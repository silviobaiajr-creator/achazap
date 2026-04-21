/**
 * Skill: intent-detector
 * Responsabilidade: Detecção de intenção via IA (fuga e cadastro proativo).
 * Mantém as chamadas Gemini isoladas do loop de roteamento principal.
 */

import { ai, GEMINI_MODEL } from '../../lib/gemini.js';
import { logTokens } from '../../lib/logger.js';
import { FugaNLPSchema, parseSafe } from '../schemas.js';
import { z } from 'zod';
import { logger } from '../../lib/logger.js';

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

/**
 * Filtro de Qualidade (Reranking): Recebe os itens brutos da busca vetorial
 * e usa o Gemini para determinar quais realmente atendem à intenção do usuário.
 */
export async function refinarCandidatosBusca(termoUsuario: string, candidatos: any[]): Promise<string[] | null> {
    if (!candidatos || candidatos.length === 0) return [];
    
    // Filtramos apenas dados essenciais para economizar tokens
    const candsSlim = candidatos.map(c => ({ id: c.id, nome: c.produto_nome, preco: c.preco_atual, un: c.unidade }));
    
    try {
        const result = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: `Você é um refinador de busca de e-commerce.
O usuário buscou o termo exato: "${termoUsuario}"
O banco de dados vetorial retornou a seguinte lista de possíveis candidatos (candsSlim):
${JSON.stringify(candsSlim)}

Sua tarefa: Retornar APENAS os IDs dos produtos que FAZEM SENTIDO e correspondem diretamente ou são sinônimos pertinentes para o que o usuário quer.
Exemplo: Se o usuário quer "Ração", não retorne o ID de "Coca-Cola" ou "Prato".
Se nada fizer sentido, retorne uma array vazia [].

Retorne EXCLUSIVAMENTE um JSON com este formato:
{"ids_validos": ["uuid1", "uuid2"]}
`,
            config: { responseMimeType: 'application/json', temperature: 0.1 },
        });
        
        logTokens('refinar_candidatos_busca', 'system', 'system', result.usageMetadata);
        const schema = z.object({ ids_validos: z.array(z.string()) });
        const dados = parseSafe(schema, result.text || '{}', { ids_validos: [] });
        return dados.ids_validos;
    } catch (e) {
        logger.error({ erro: e, termo: termoUsuario }, '[Motor Semântico] Erro no Reranking do Gemini');
        return null; // Sinaliza falha para o orchestrator ativar o Fallback
    }
}
