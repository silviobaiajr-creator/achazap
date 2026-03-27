import { GoogleGenAI, Type } from '@google/genai';
import { sendTextMessage, type WhatsAppMessage } from '../lib/whatsapp.js';
import {
    buscarOfertasPorRegiao,
    analisarHistoricoPreco,
    gerarLinkRedirecionamento,
    cadastrarAtualizarUsuario,
    obterPerfilUsuario,
} from './skills.js';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

// ============================================================
// Definição das tools para o Gemini (Function Calling)
// ============================================================
const tools = [
    {
        functionDeclarations: [
            {
                name: 'buscar_ofertas_por_regiao',
                description: 'Busca produtos no catálogo filtrando por cidade, bairro e termo de busca. Retorna apenas lojas com saldo de cliques > 0.',
                parameters: {
                    type: Type.OBJECT,
                    properties: {
                        cidade: { type: Type.STRING, description: 'Cidade do usuário' },
                        bairro: { type: Type.STRING, description: 'Bairro do usuário' },
                        query: { type: Type.STRING, description: 'Termo de busca, ex: "arroz 5kg"' },
                    } as Record<string, { type: Type; description?: string }>,
                    required: ['cidade', 'bairro', 'query'],
                },
            },
            {
                name: 'analisar_historico_preco',
                description: 'Verifica se o preço atual é o menor dos últimos N dias. Retorna alerta de oferta real.',
                parameters: {
                    type: Type.OBJECT,
                    properties: {
                        loja_id: { type: Type.STRING },
                        produto_nome: { type: Type.STRING },
                        janela_dias: { type: Type.NUMBER, description: 'Padrão: 90 dias' },
                    } as Record<string, { type: Type; description?: string }>,
                    required: ['loja_id', 'produto_nome'],
                },
            },
            {
                name: 'gerar_link_redirecionamento',
                description: 'Gera link intermediário do AchaZap. O clique do usuário nesse link debita 1 clique da loja e redireciona para o WhatsApp.',
                parameters: {
                    type: Type.OBJECT,
                    properties: {
                        loja_id: { type: Type.STRING },
                        usuario_id: { type: Type.STRING },
                        produto_nome: { type: Type.STRING },
                        preco: { type: Type.NUMBER },
                        faz_delivery: { type: Type.BOOLEAN },
                        whatsapp_loja: { type: Type.STRING },
                    } as Record<string, { type: Type; description?: string }>,
                    required: ['loja_id', 'usuario_id', 'produto_nome', 'preco', 'faz_delivery', 'whatsapp_loja'],
                },
            },
            {
                name: 'cadastrar_atualizar_usuario',
                description: 'Cria o usuário na primeira interação ou atualiza cidade/bairro.',
                parameters: {
                    type: Type.OBJECT,
                    properties: {
                        whatsapp: { type: Type.STRING },
                        nome: { type: Type.STRING },
                        cidade: { type: Type.STRING },
                        bairro: { type: Type.STRING },
                    } as Record<string, { type: Type; description?: string }>,
                    required: ['whatsapp', 'cidade', 'bairro'],
                },
            },
            {
                name: 'obter_perfil_usuario',
                description: 'Recupera o perfil (cidade e bairro) de um usuário pelo WhatsApp.',
                parameters: {
                    type: Type.OBJECT,
                    properties: {
                        whatsapp: { type: Type.STRING },
                    } as Record<string, { type: Type; description?: string }>,
                    required: ['whatsapp'],
                },
            },
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
    const userText = msg.text?.body ?? '[mensagem não textual recebida]';
    const messageContext = `[Número de WhatsApp do Usuário: ${msg.from}]\nMensagem do Usuário: ${userText}`;

    const chat = ai.chats.create({
        model: 'gemini-2.5-flash',
        config: {
            systemInstruction: SYSTEM_PROMPT,
            tools,
        },
    });

    let response = await chat.sendMessage({ message: messageContext });

    // Loop de Function Calling até a IA dar uma resposta final de texto
    while (true) {
        const functionCalls = response.functionCalls ?? [];

        if (functionCalls.length === 0) {
            // Resposta final — envia ao usuário
            const finalText = response.text;
            if (finalText) {
                await sendTextMessage(msg.from, finalText);
            }
            break;
        }

        // Executa todas as skills chamadas pela IA
        const functionResponses = await Promise.all(
            functionCalls.map(async (fc) => {
                console.log(`[Gemini] Chamando skill: ${fc.name}`, fc.args);
                const result = await executarSkill(fc.name!, fc.args as Record<string, unknown>);
                return {
                    name: fc.name!,
                    response: { result },
                };
            })
        );

        // Retorna os resultados para a IA continuar
        response = await chat.sendMessage({ message: functionResponses.map(fr => ({
            functionResponse: fr
        })) });
    }
}
