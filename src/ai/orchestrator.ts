import { GoogleGenAI, Type, Part } from '@google/genai';
import { sendTextMessage, downloadMedia, type WhatsAppMessage } from '../lib/whatsapp.js';
import {
    buscarOfertasPorRegiao,
    analisarHistoricoPreco,
    gerarLinkRedirecionamento,
    cadastrarAtualizarUsuario,
    obterPerfilUsuario,
    obterPerfilLoja,
    ingerirCatalogo,
    obterEstatisticasLoja,
} from './skills.js';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

// ============================================================
// As tools (Skills)
// ============================================================
const toolsUsuario = [
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
                description: 'Gera link do AchaZap. O clique desse link debita 1 clique da loja e redireciona para o WhatsApp.',
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
                description: 'Recupera o perfil (cidade e bairro) do usuário.',
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

const toolsLojista = [
    {
        functionDeclarations: [
            {
                name: 'ingerir_catalogo',
                description: 'Grava produtos extraídos do CSV, Imagem ou Áudio no catálogo da loja.',
                parameters: {
                    type: Type.OBJECT,
                    properties: {
                        loja_id: { type: Type.STRING },
                        itens: {
                            type: Type.ARRAY,
                            items: {
                                type: Type.OBJECT,
                                properties: {
                                    produto_nome: { type: Type.STRING },
                                    preco: { type: Type.NUMBER },
                                    unidade: { type: Type.STRING, description: "ex: 'un', 'kg', 'cx'" },
                                },
                                required: ['produto_nome', 'preco'],
                            },
                        },
                        fonte_ingestao: { type: Type.STRING, description: "'csv' | 'foto' | 'audio' | 'manual'" },
                    } as Record<string, { type: Type; description?: string }>,
                    required: ['loja_id', 'itens', 'fonte_ingestao'],
                },
            },
            {
                name: 'obter_estatisticas_loja',
                description: 'Recupera o saldo de cliques, o ranking dos produtos mais clicados e o total de visitas (cliques) dos últimos 30 dias.',
                parameters: {
                    type: Type.OBJECT,
                    properties: {
                        loja_id: { type: Type.STRING },
                    } as Record<string, { type: Type; description?: string }>,
                    required: ['loja_id'],
                },
            },
        ],
    },
];

async function executarSkill(name: string, args: Record<string, unknown>) {
    switch (name) {
        case 'buscar_ofertas_por_regiao':
            return buscarOfertasPorRegiao(args as any);
        case 'analisar_historico_preco':
            return analisarHistoricoPreco(args as any);
        case 'gerar_link_redirecionamento':
            return gerarLinkRedirecionamento(args as any);
        case 'cadastrar_atualizar_usuario':
            return cadastrarAtualizarUsuario(args as any);
        case 'obter_perfil_usuario':
            return obterPerfilUsuario(args as any);
        case 'ingerir_catalogo':
            return ingerirCatalogo(args as any);
        case 'obter_estatisticas_loja':
            return obterEstatisticasLoja(args as any);
        default:
            throw new Error(`Skill desconhecida: ${name}`);
    }
}

// ============================================================
// Orquestrador principal
// ============================================================
export async function processMessage(msg: WhatsAppMessage): Promise<void> {
    const from = msg.from;
    const loja = await obterPerfilLoja({ whatsapp: from });

    const isLojista = !!loja;
    const tools = isLojista ? toolsLojista : toolsUsuario;

    const SYSTEM_PROMPT = isLojista
        ? `Você é o AchaZap (Portal do Lojista). Você está falando com o gestor da loja '${loja.nome}' (ID: ${loja.id}).
O lojista pode:
1. Enviar anexos (Planilhas, Fotos, Áudios) de preços -> Chame ingerir_catalogo.
2. Perguntar sobre o desempenho, saldo ou cliques da loja -> Chame obter_estatisticas_loja.
Seja extremamente profissional, use termos como "Performance", "Engajamento" e "Retorno sobre Investimento".
Ao mostrar o ranking de produtos, use emojis de medalha (🥇, 🥈, 🥉) para gerar valor.`
        : `Você é o AchaZap, o maior buscador de ofertas locais do WhatsApp.
REGRAS CRÍTICAS DE NEGÓCIOS (LEAD CEGO):
1. NUNCA revele o nome ou o endereço exato da loja na sua resposta em texto.
2. Diga apenas o Bairro da loja e o preço encontrado. Ex: "Encontrei no Umarizal por R$ 20,00".
3. VERIFIQUE o campo "faz_delivery" retornado na busca para adaptar sua resposta:
   - Se faz_delivery=true: Diga "Clique no link abaixo para ver qual é a loja e já pedir pelo WhatsApp para entregarem ou separarem o seu!"
   - Se faz_delivery=false: Diga "Clique no link abaixo para descobrir qual é o mercado e garantir essa oferta física antes que o estoque acabe."
4. Sempre chame gerar_link_redirecionamento() para criar o link magico e entregue-o ao usuário para "revelar a loja" e garantir o repasse.
5. Sempre chame obter_perfil_usuario() no primeiro Oi para obter cidade/bairro.`;

    // Processar conteúdo e mídias
    let payloadParts: Part[] = [];

    // Adiciona o texto principal
    const userText = msg.text?.body ? `[WhatsApp: ${from}]\nMensagem: ${msg.text.body}` : `[WhatsApp: ${from}]`;
    payloadParts.push({ text: userText });

    // Lida com anexos/mídia
    if (msg.type === 'document' && msg.document) {
        const buffer = await downloadMedia(msg.document.id);
        // Considerando CSV nativamente como texto
        payloadParts.push({ text: `\n[PLANILHA ANEXADA]:\n${buffer.toString('utf-8')}` });
    } else if (msg.type === 'image' && msg.image) {
        const buffer = await downloadMedia(msg.image.id);
        payloadParts.push({ inlineData: { data: buffer.toString('base64'), mimeType: msg.image.mime_type } });
    } else if (msg.type === 'audio' && msg.audio) {
        const buffer = await downloadMedia(msg.audio.id);
        payloadParts.push({ inlineData: { data: buffer.toString('base64'), mimeType: msg.audio.mime_type } });
    }

    const chat = ai.chats.create({
        model: 'gemini-2.5-flash',
        config: { systemInstruction: SYSTEM_PROMPT, tools },
    });

    let response = await chat.sendMessage({ message: payloadParts });

    // Loop de Function Calling
    while (true) {
        const functionCalls = response.functionCalls ?? [];

        if (functionCalls.length === 0) {
            const finalText = response.text;
            console.log(`[Gemini] Resposta final gerada:`, finalText);
            if (finalText) {
                console.log(`[WhatsApp] Disparando sendTextMessage para ${from}...`);
                await sendTextMessage(from, finalText);
                console.log(`[WhatsApp] Mensagem enviada fisicamente para a Meta sem falhas!`);
            } else {
                console.log(`[Aviso] O Gemini retornou texto VAZIO e o Axios não foi chamado.`);
            }
            break;
        }

        const functionResponses = await Promise.all(
            functionCalls.map(async (fc) => {
                console.log(`[Gemini] Chamando skill: ${fc.name}`, fc.args);
                const result = await executarSkill(fc.name!, fc.args as Record<string, unknown>);
                return { name: fc.name!, response: { result } };
            })
        );

        response = await chat.sendMessage({
            message: functionResponses.map(fr => ({ functionResponse: fr }))
        });
    }
}
