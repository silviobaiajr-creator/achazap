import { GoogleGenerativeAI, Tool, FunctionDeclaration } from '@google/generative-ai';
import { sendTextMessage, type WhatsAppMessage } from '../lib/whatsapp.js';
import {
    buscarOfertasPorRegiao,
    analisarHistoricoPreco,
    gerarLinkRedirecionamento,
    cadastrarAtualizarUsuario,
    obterPerfilUsuario,
} from './skills.js';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

// ============================================================
// Definição das tools para o Gemini (Function Calling)
// ============================================================
const tools: Tool[] = [
    {
        functionDeclarations: [
            {
                name: 'buscar_ofertas_por_regiao',
                description: 'Busca produtos no catálogo filtrando por cidade, bairro e termo de busca. Retorna apenas lojas com saldo de cliques > 0.',
                parameters: {
                    type: 'object',
                    properties: {
                        cidade: { type: 'string', description: 'Cidade do usuário' },
                        bairro: { type: 'string', description: 'Bairro do usuário' },
                        query: { type: 'string', description: 'Termo de busca, ex: "arroz 5kg"' },
                    },
                    required: ['cidade', 'bairro', 'query'],
                },
            } as FunctionDeclaration,
            {
                name: 'analisar_historico_preco',
                description: 'Verifica se o preço atual é o menor dos últimos N dias. Retorna alerta de oferta real.',
                parameters: {
                    type: 'object',
                    properties: {
                        loja_id: { type: 'string' },
                        produto_nome: { type: 'string' },
                        janela_dias: { type: 'number', description: 'Padrão: 90 dias' },
                    },
                    required: ['loja_id', 'produto_nome'],
                },
            } as FunctionDeclaration,
            {
                name: 'gerar_link_redirecionamento',
                description: 'Gera link intermediário do AchaZap. O clique do usuário nesse link debita 1 clique da loja e redireciona para o WhatsApp.',
                parameters: {
                    type: 'object',
                    properties: {
                        loja_id: { type: 'string' },
                        usuario_id: { type: 'string' },
                        produto_nome: { type: 'string' },
                        preco: { type: 'number' },
                        faz_delivery: { type: 'boolean' },
                        whatsapp_loja: { type: 'string' },
                    },
                    required: ['loja_id', 'usuario_id', 'produto_nome', 'preco', 'faz_delivery', 'whatsapp_loja'],
                },
            } as FunctionDeclaration,
            {
                name: 'cadastrar_atualizar_usuario',
                description: 'Cria o usuário na primeira interação ou atualiza cidade/bairro.',
                parameters: {
                    type: 'object',
                    properties: {
                        whatsapp: { type: 'string' },
                        nome: { type: 'string' },
                        cidade: { type: 'string' },
                        bairro: { type: 'string' },
                    },
                    required: ['whatsapp', 'cidade', 'bairro'],
                },
            } as FunctionDeclaration,
            {
                name: 'obter_perfil_usuario',
                description: 'Recupera o perfil (cidade e bairro) de um usuário pelo WhatsApp.',
                parameters: {
                    type: 'object',
                    properties: {
                        whatsapp: { type: 'string' },
                    },
                    required: ['whatsapp'],
                },
            } as FunctionDeclaration,
        ],
    },
];

// ============================================================
// Mapa de execução das skills
// ============================================================
async function executarSkill(name: string, args: Record<string, unknown>) {
    switch (name) {
        case 'buscar_ofertas_por_regiao':
            return buscarOfertasPorRegiao(args as Parameters<typeof buscarOfertasPorRegiao>[0]);
        case 'analisar_historico_preco':
            return analisarHistoricoPreco(args as Parameters<typeof analisarHistoricoPreco>[0]);
        case 'gerar_link_redirecionamento':
            return gerarLinkRedirecionamento(args as Parameters<typeof gerarLinkRedirecionamento>[0]);
        case 'cadastrar_atualizar_usuario':
            return cadastrarAtualizarUsuario(args as Parameters<typeof cadastrarAtualizarUsuario>[0]);
        case 'obter_perfil_usuario':
            return obterPerfilUsuario(args as Parameters<typeof obterPerfilUsuario>[0]);
        default:
            throw new Error(`Skill desconhecida: ${name}`);
    }
}

// ============================================================
// System prompt da IA
// ============================================================
const SYSTEM_PROMPT = `
Você é o AchaZap, um assistente de IA via WhatsApp que ajuda moradores a encontrar 
produtos no varejo do seu bairro (supermercados, farmácias, lojas de construção, etc.).

REGRAS IMPORTANTES:
1. Sempre use obter_perfil_usuario no início da conversa para obter a localização do usuário.
2. Se não houver perfil, colete nome, cidade e bairro antes de qualquer busca.
3. Ao encontrar produtos, sempre use analisar_historico_preco para avisar se é oferta real.
4. Gere o link intermediário via gerar_link_redirecionamento — nunca wa.me direto.
5. Seja conciso, amigável e use emojis com moderação.
6. Responda sempre em português do Brasil.
`;

// ============================================================
// Orquestrador principal
// ============================================================
export async function processMessage(msg: WhatsAppMessage): Promise<void> {
    const model = genAI.getGenerativeModel({
        model: 'gemini-2.0-flash',
        tools,
        systemInstruction: SYSTEM_PROMPT,
    });

    // Monta o conteúdo inicial com base no tipo de mensagem
    const userText = msg.text?.body ?? '[mensagem não textual recebida]';

    const chat = model.startChat();
    let response = await chat.sendMessage(userText);

    // Loop de Function Calling até a IA dar uma resposta final de texto
    while (true) {
        const candidates = response.response.candidates;
        const parts = candidates?.[0]?.content?.parts ?? [];

        const functionCalls = parts.filter((p) => p.functionCall);

        if (functionCalls.length === 0) {
            // Resposta final — envia ao usuário
            const finalText = response.response.text();
            if (finalText) {
                await sendTextMessage(msg.from, finalText);
            }
            break;
        }

        // Executa todas as skills chamadas pela IA
        const functionResults = await Promise.all(
            functionCalls.map(async (part) => {
                const { name, args } = part.functionCall!;
                console.log(`[Gemini] Chamando skill: ${name}`, args);
                const result = await executarSkill(name, args as Record<string, unknown>);
                return {
                    functionResponse: { name, response: { result } },
                };
            })
        );

        // Retorna os resultados para a IA continuar
        response = await chat.sendMessage(functionResults);
    }
}
