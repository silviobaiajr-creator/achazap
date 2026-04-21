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

// ============================================================
// EXTRAÇÃO DE INTENÇÃO ESTRUTURADA (Lista de Compras Inteligente)
// ============================================================

export interface ItemIntencao {
    item: string;
    marca?: string | null;
    especificacao?: string | null;
    tamanho?: string | null;
    qualquer_marca?: boolean; // Se o usuário disse "qualquer", "mais barato", "não importa a marca"
}

const ItemIntencaoSchema = z.object({
    item:           z.string(),
    marca:          z.string().nullable().optional(),
    especificacao:  z.string().nullable().optional(),
    tamanho:        z.string().nullable().optional(),
    qualquer_marca: z.boolean().default(false),
});
const ListaIntencaoSchema = z.object({ itens: z.array(ItemIntencaoSchema) });

/**
 * Extrai uma lista de intenções estruturadas da mensagem do consumidor.
 */
export async function extrairListaCompras(texto: string): Promise<ItemIntencao[]> {
    if (!texto || texto.trim().length === 0) return [];

    try {
        const result = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: `Você é um assistente de lista de compras. Analise a mensagem e extraia cada produto com seus atributos.
Mensagem: "${texto}"

Para cada produto, extraia:
- item: Nome genérico (ex: "Café", "Arroz"). Obrigatório.
- marca: Marca específica se mencionada.
- especificacao: Tipo/preparo (ex: "integral", "moído").
- tamanho: Peso/volume (ex: "1kg", "500g").
- qualquer_marca: true se o usuário usou termos como "qualquer", "o mais barato", "não importa a marca", "tanto faz". Caso contrário, false.

Exemplos:
- "Quero qualquer arroz e um feijão barato" → [{"item":"Arroz","marca":null,...,"qualquer_marca":true},{"item":"Feijão",...,"qualquer_marca":true}]
- "Café Melitta" → [{"item":"Café","marca":"Melitta",...,"qualquer_marca":false}]

Retorne APENAS um JSON: {"itens":[{"item":"...","qualquer_marca":boolean}]}`,
            config: { responseMimeType: 'application/json', temperature: 0.0 },
        });

        logTokens('extrair_lista_compras', 'system', 'system', result.usageMetadata);
        const dados = parseSafe(ListaIntencaoSchema, result.text || '{}', { itens: [] });

        if (!dados.itens || dados.itens.length === 0) return [{ item: texto.trim(), qualquer_marca: false }];

        return dados.itens.map(i => ({
            item:           i.item.trim(),
            marca:          i.marca         ?? null,
            especificacao:  i.especificacao ?? null,
            tamanho:        i.tamanho       ?? null,
            qualquer_marca: i.qualquer_marca ?? false,
        })).slice(0, 8);
    } catch (e) {
        logger.error({ erro: e, texto }, '[Motor Semântico] Erro NLP extrairListaCompras');
        return [{ item: texto.trim(), qualquer_marca: false }];
    }
}
