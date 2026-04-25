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
 * Roteador Global de Intenção (IDLE).
 * Consolida a detecção de Fuga (cancelar) e Cadastro Proativo em uma única chamada de IA.
 * Reduz custos em 50% no estado IDLE.
 */
export async function rotearIntencaoGlobal(texto: string): Promise<{ ehFuga: boolean, ehCadastro: boolean }> {
    const textoLower = texto.toLowerCase().trim();

    // Regex rápido: Comandos diretos não precisam de IA
    const PALAVRAS_FUGA_REGEX = /^(menu|sair|cancelar|parar|tchau|vaza|cancela|xau|limpar)$/i;
    if (PALAVRAS_FUGA_REGEX.test(textoLower)) {
        return { ehFuga: true, ehCadastro: false };
    }

    // Comandos de sistema
    if (textoLower.startsWith('/') || textoLower === '0' || textoLower === '1') {
        return { ehFuga: false, ehCadastro: false }; // Deixa o roteador de comandos tratar
    }

    try {
        const result = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: `Você é um roteador de intenções para um assistente de mercado. Analise a frase e classifique:
1. FUGA: O usuário quer cancelar, sair, voltar ao menu ou encerrar a operação atual.
2. CADASTRO: O usuário está enviando o nome de um produto, preço ou intenção clara de adicionar algo ao estoque (Ex: "Arroz 10", "Lança aí: Leite").
3. CONVERSA: Saudações ou perguntas genéricas (Ex: "Oi", "Como funciona?").

Retorne APENAS o JSON: {"fuga": boolean, "cadastro": boolean}

Frase: "${texto}"

JSON:`,
            config: { responseMimeType: 'application/json' },
        });
        logTokens('rotear_intencao_global', 'system', 'system', result.usageMetadata);
        const schema = z.object({ fuga: z.boolean(), cadastro: z.boolean() });
        const dados = parseSafe(schema, result.text || '{}', { fuga: false, cadastro: false });
        return { ehFuga: dados.fuga, ehCadastro: dados.cadastro };
    } catch {
        return { ehFuga: false, ehCadastro: false };
    }
}

/**
 * Detecta se o texto indica intenção de sair/cancelar o fluxo atual.
 * Usado como fallback ou em fluxos ativos.
 */
export async function detectarFugaNLP(texto: string): Promise<boolean> {
    try {
        const result = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: `O usuário quer CANCELAR ou SAIR do fluxo atual? (Ignorar nomes de produtos). 
            Retorne APENAS JSON: {"fuga": boolean}
            Frase: "${texto}"`,
            config: { responseMimeType: 'application/json' },
        });
        logTokens('detectar_fuga_nlp', 'system', 'system', result.usageMetadata);
        const schema = z.object({ fuga: z.boolean() });
        const dados = parseSafe(schema, result.text || '{}', { fuga: false });
        return dados.fuga;
    } catch {
        return false;
    }
}

/**
 * @deprecated Use rotearIntencaoGlobal no estado IDLE.
 */
export async function detectarIntencaoProativa(texto: string): Promise<boolean> {
    const res = await rotearIntencaoGlobal(texto);
    return res.ehCadastro;
}

/**
 * Filtro de Qualidade em Lote: Refina múltiplos produtos e seus candidatos em uma ÚNICA chamada.
 * Reduz custos em N vezes (onde N é o número de produtos no lote).
 */
export async function batchRefinarCandidatosBusca(lote: Array<{termo: string, candidatos: any[]}>): Promise<Map<string, string[]>> {
    const mapaResultados = new Map<string, string[]>();
    if (!lote || lote.length === 0) return mapaResultados;

    // Filtra apenas o essencial para o prompt
    const loteSlim = lote.map((item, idx) => ({
        id_lote: idx,
        busca: item.termo,
        candidatos: item.candidatos.map(c => ({ id: c.id, nome: c.produto_nome, preco: c.preco_atual, un: c.unidade }))
    }));

    try {
        const result = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: `Você é um analista de estoque de supermercado. Recebeu uma lista de buscas e candidatos do banco de dados.
Sua missão: Para cada "id_lote", identifique quais candidatos são EXATAMENTE o mesmo produto buscado.

Regras:
1. Rejeite categorias cruzadas (Ex: Busca "Pão" -> Rejeite "Pão de Queijo").
2. Rejeite se for apenas ingrediente (Ex: Busca "Tapioca" -> Rejeite "Biscoito de Tapioca").
3. Se houver dúvidas, prefira NÃO validar o ID.

Retorne EXCLUSIVAMENTE um JSON:
{"resultados": [{"id_lote": 0, "ids_validos": ["uuid..."]}, {"id_lote": 1, "ids_validos": []}]}

LOTE:
${JSON.stringify(loteSlim)}`,
            config: { responseMimeType: 'application/json', temperature: 0.0 },
        });

        logTokens('batch_refinar_candidatos', 'system', 'system', result.usageMetadata);
        const schema = z.object({ resultados: z.array(z.object({ id_lote: z.number(), ids_validos: z.array(z.string()) })) });
        const dados = parseSafe(schema, result.text || '{}', { resultados: [] });

        dados.resultados.forEach(res => {
            const termoOriginal = lote[res.id_lote]?.termo;
            if (termoOriginal) mapaResultados.set(termoOriginal, res.ids_validos);
        });

        return mapaResultados;
    } catch (e) {
        logger.error({ e }, '[Batch Reranking] Erro na chamada Gemini');
        return mapaResultados;
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
