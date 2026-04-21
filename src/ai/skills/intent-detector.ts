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
            contents: `Você é um refinador de busca de e-commerce MUITO RIGOROSO.
O usuário buscou o termo exato: "${termoUsuario}"
O banco de dados retornou a seguinte lista de possíveis candidatos (candsSlim):
${JSON.stringify(candsSlim)}

Sua tarefa: Retornar APENAS os IDs dos produtos que atendem DIRETAMENTE à intenção de busca.
REGRAS RÍGIDAS:
1. NÃO aceite categorias cruzadas (Ex: Se a busca for "Tapioca", REJEITE "Sorvete de Tapioca" ou "Biscoito sabor Tapioca").
2. NÃO aceite preparos incompatíveis (Ex: Se a busca for "Cuscuz", REJEITE "Fubá Mimoso", pois Fubá tipicamente faz polenta/bolo, aceitando apenas "Flocão" ou "Cuscuz").
3. Se a intenção do usuário é um ingrediente base, produtos compostos que o contenham devem ser vetados.
4. Se NENHUM produto atender exatamente à intenção, não tente adivinhar. Retorne uma array vazia [].

Retorne EXCLUSIVAMENTE um JSON com este formato:
{"ids_validos": ["uuid1", "uuid2"]}
`,
            config: { responseMimeType: 'application/json', temperature: 0.0 },
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

/**
 * Função NLP para o Modo Lista de Compras.
 * Lê a mensagem do usuário e separa em itens de consumo unificados.
 */
export async function extrairListaCompras(texto: string): Promise<string[]> {
    if (!texto || texto.trim().length === 0) return [];

    try {
        const result = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: `Você é uma IA extratora de ingredientes e listas de compras.
O usuário digitou: "${texto}"

Objetivo:
- Analise se a frase contém um ou múltiplos produtos (itens de supermercado, comida, bebida, mercearia, etc).
- Para cada produto encontrado, crie uma string simples contendo as palavras-chave principais do item e guarde numa array.
- Exemplo 1: "Tem café, açúcar e 1 pacote de macarrão?" -> ["café", "açúcar", "pacote de macarrão"]
- Exemplo 2: "Me dá um quilo de feijão preto" -> ["feijão preto"]
- Exemplo 3: "Quero tomar um café com leite com tapioca e pão quentinho" -> ["café com leite", "tapioca", "pão"] ou ["café", "leite", "tapioca", "pão"] (o que fizer mais sentido).
- Remova conjunções, interjeições e texto não relacionado à compra ("Quero comprar", "Tem", "Oi", etc).

Retorne APENAS um JSON no formato:
{"itens": ["item1", "item2"]}
`,
            config: { responseMimeType: 'application/json', temperature: 0.1 },
        });

        logTokens('extrair_lista_compras', 'system', 'system', result.usageMetadata);
        const schema = z.object({ itens: z.array(z.string()) });
        const dados = parseSafe(schema, result.text || '{}', { itens: [texto.trim()] });
        
        // Retorna a própria string sanitizada caso a IA falhe em particionar
        if (!dados.itens || dados.itens.length === 0) {
            return [texto.trim()];
        }
        
        // Sanitiza a lista retornada, cortando strings muito longas como fallback global de erro
        return dados.itens.map(i => i.trim()).filter(i => i.length > 0).slice(0, 5); // Limite de 5 itens para segurança
    } catch (e) {
        logger.error({ erro: e, texto }, '[Motor Semântico] Erro NLP extrairListaCompras');
        return [texto.trim()]; // Fallback para busca unificada
    }
}
