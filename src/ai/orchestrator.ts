import { GoogleGenAI, Type, Part } from '@google/genai';
import { sendTextMessage, downloadMedia, sendInteractiveButtons, sendListMessage, sendCTAUrlMessage, type WhatsAppMessage } from '../lib/whatsapp.js';
import { detectarEstadoPorWhatsApp } from '../lib/location.js';
import {
    buscarOfertasPorRegiao,
    analisarHistoricoPreco,
    gerarLinkRedirecionamento,
    cadastrarAtualizarUsuario,
    obterPerfilUsuario,
    obterPerfilLoja,
    ingerirCatalogo,
    obterEstatisticasLoja,
    cadastrarOfertaDesconto,
    buscarOfertasDesconto,
    buscarOfertasProdutoComDesconto,
} from './skills.js';
import { supabase } from '../lib/supabase.js';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

// Função utilitária para delay
const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

// ============================================================
// As tools (Skills)
// ============================================================
const toolsUsuario = [
    {
        functionDeclarations: [
            {
                name: 'buscar_ofertas_por_regiao',
                description: 'Busca produtos no catálogo filtrando por cidade, bairro, estado e termo de busca. Retorna apenas lojas com saldo de cliques > 0.',
                parameters: {
                    type: Type.OBJECT,
                    properties: {
                        cidade: { type: Type.STRING, description: 'Cidade do usuário' },
                        bairro: { type: Type.STRING, description: 'Bairro do usuário' },
                        estado: { type: Type.STRING, description: 'Estado (UF) do usuário, ex: "PA", "SP"' },
                        query: { type: Type.STRING, description: 'Termo de busca, ex: "arroz 5kg"' },
                    } as Record<string, { type: Type; description?: string }>,
                    required: ['cidade', 'bairro', 'estado', 'query'],
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
                        usuario_id: { type: Type.STRING, description: 'ID Único (UUID) do usuário retornado pelo perfil. NUNCA use o número do WhatsApp aqui.' },
                        produto_nome: { type: Type.STRING },
                        preco: { type: Type.NUMBER },
                        bairro: { type: Type.STRING },
                        faz_delivery: { type: Type.BOOLEAN },
                        whatsapp_loja: { type: Type.STRING },
                    } as Record<string, { type: Type; description?: string }>,
                    required: ['loja_id', 'usuario_id', 'produto_nome', 'preco', 'bairro', 'faz_delivery', 'whatsapp_loja'],
                },
            },
            {
                name: 'cadastrar_atualizar_usuario',
                description: 'Cria o usuário na primeira interação ou atualiza nome, cidade, bairro e estado.',
                parameters: {
                    type: Type.OBJECT,
                    properties: {
                        whatsapp: { type: Type.STRING },
                        nome: { type: Type.STRING, description: 'Nome real do consumidor' },
                        cidade: { type: Type.STRING },
                        bairro: { type: Type.STRING },
                        estado: { type: Type.STRING, description: 'Estado (UF) ex: "PA"' },
                    } as Record<string, { type: Type; description?: string }>,
                    required: ['whatsapp', 'nome', 'cidade', 'bairro', 'estado'],
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
            {
                name: 'cadastrar_oferta_desconto',
                description: 'Cadastra uma oferta de desconto por ticket mínimo. Ex: compre acima de R$500 e ganhe 10% off.',
                parameters: {
                    type: Type.OBJECT,
                    properties: {
                        loja_id: { type: Type.STRING },
                        valor_minimo: { type: Type.NUMBER, description: 'Valor mínimo da compra para ganhar o desconto (ex: 500)' },
                        percentual: { type: Type.NUMBER, description: 'Percentual de desconto (ex: 10)' },
                        validade: { type: Type.STRING, description: 'Data de validade da oferta (formato: YYYY-MM-DD)' },
                        produto_filtro: { type: Type.STRING, description: 'Opcional: produto específico que a oferta se aplica (ex: "arroz"). Se vazio, aplica a toda a loja.' },
                    } as Record<string, { type: Type; description?: string }>,
                    required: ['loja_id', 'valor_minimo', 'percentual', 'validade'],
                },
            },
        ],
    },
];

const toolsBuscaDesconto = [
    {
        functionDeclarations: [
            {
                name: 'buscar_ofertas_desconto',
                description: 'Busca lojas que têm ofertas de desconto por ticket mínimo (ex: compre R$500 e ganhe 10% off).',
                parameters: {
                    type: Type.OBJECT,
                    properties: {
                        cidade: { type: Type.STRING },
                        bairro: { type: Type.STRING },
                        estado: { type: Type.STRING },
                        percentual_minimo: { type: Type.NUMBER, description: 'Opcional: mínimo de percentual de desconto (ex: 10)' },
                        produto: { type: Type.STRING, description: 'Opcional: produto específico que a oferta deve cobrir' },
                    } as Record<string, { type: Type; description?: string }>,
                    required: ['cidade', 'bairro', 'estado'],
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
        case 'cadastrar_oferta_desconto':
            return cadastrarOfertaDesconto(args as any);
        case 'buscar_ofertas_desconto':
            return buscarOfertasDesconto(args as any);
        default:
            throw new Error(`Skill desconhecida: ${name}`);
    }
}

// ============================================================
// Orquestrador principal
// ============================================================
export async function processMessage(msg: WhatsAppMessage): Promise<void> {
    const from = msg.from;
    console.log(`[Debug] Mensagem de: ${from}`);
    const loja = await obterPerfilLoja({ whatsapp: from });
    console.log(`[Debug] Loja encontrada:`, loja);
    const estadoSugerido = detectarEstadoPorWhatsApp(from);

    const isLojista = !!loja;
    const tools = isLojista ? toolsLojista : [...toolsUsuario, ...toolsBuscaDesconto];

    // 1. Busca perfil do usuário ANTES para injetar no Prompt
    const perfil = !isLojista ? await obterPerfilUsuario({ whatsapp: from }) : null;

    const SYSTEM_PROMPT = isLojista
        ? `Você é o AchaZap (Portal do Lojista). Você está falando com o gestor da loja '${loja.nome}' (ID: ${loja.id}).
Seja profissional e prestativo.

FUNCIONALIDADES DISPONÍVEIS:
- Use 'cadastrar_oferta_desconto' para criar ofertas de desconto por ticket mínimo.
  Exemplo: "Quero criar oferta: compras acima de R$500, 10% desconto, válida até 30/04"
  O sistema vai entender e salvar automaticamente.

- Use 'obter_estatisticas_loja' para ver o saldo de cliques e ranking de produtos.

- Use 'ingerir_catalogo' para adicionar produtos via CSV, foto ou áudio.

RESPONDA de forma 自然 e direta.`
        : `Você é o AchaZap, buscador de ofertas locais.
INFORMAÇÃO GEOGRÁFICA: Estado sugerido: ${estadoSugerido ?? 'Não identificado'}.
PERFIL: ${perfil ? `Nome: ${perfil.nome}, Cidade: ${perfil.cidade}, Bairro: ${perfil.bairro}, Estado: ${perfil.estado}` : 'NÃO CADASTRADO'}.

COMANDOS DE SISTEMA (PRIORIDADE MÁXIMA):
1. Se o perfil acima existir, NUNCA peça nome/cidade.
2. É TERMINANTEMENTE PROIBIDO escrever URLs, links ou strings com ".com", ".br", "http" ou "www" no seu texto. 
3. Para CADA produto retornado em 'buscar_ofertas_por_regiao', você DEVE obrigatoriamente chamar 'gerar_link_redirecionamento'.
4. SUA RESPOSTA DE TEXTO DEVE SER CURTÍSSIMA - NO MÁXIMO 8 PALAVRAS! Exemplo: "Encontrei estas ofertas em Castanheira:".
   - Os produtos com preço e link SERÃO ENVIADOS AUTOMATICAMENTE em botões. NÃO inclua preços, nomes de lojas ou detalhes nos produtos na sua resposta de texto.
   - Apenas a frase introdutória!

BUSCA DE DESCONTOS:
- Se o usuário buscar "oferta com desconto", "desconto", "promoção" ou similares, use 'buscar_ofertas_desconto'.
- Se o usuário buscar um produto específico (ex: "arroz"), use 'buscar_ofertas_por_regiao' normalmente - a oferta de desconto da loja já aparece junto automaticamente.

REGRAS:
- Se não houver perfil, peça educadamente.
- NUNCA mostre o nome da loja no texto.
- Se não encontrar nada, sugira outro termo.`;

    // Processar conteúdo e mídias
    let payloadParts: Part[] = [];

    // Adiciona o texto principal
    const userMessageText = msg.text?.body || (msg.type === 'interactive' ? msg.interactive?.button_reply?.title : '');
    const userTextForAI = userMessageText ? `[WhatsApp: ${from}]\nMensagem: ${userMessageText}` : `[WhatsApp: ${from}]`;
    payloadParts.push({ text: userTextForAI });

    // Salva a mensagem do usuário no banco (se houver texto)
    if (userMessageText) {
        await supabase.from('historico_mensagens').insert({
            whatsapp: from,
            role: 'user',
            content: userMessageText
        });
    }

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

    let redirectOptions: any[] = [];

    // Loop de Function Calling
    while (true) {
        const functionCalls = response.functionCalls ?? [];

        if (functionCalls.length === 0) {
            const finalText = response.text;
            console.log(`[Gemini] Resposta final gerada:`, finalText);

            if (redirectOptions.length > 0) {
                // Efeito Vitrine: Enviar mensagens individuais com link direto (CTA URL)
                if (finalText) {
                    await sendTextMessage(from, finalText);
                    await delay(800);
                }

                // Ordena do menor para o maior preço, depois limita aos Top 5
                redirectOptions.sort((a, b) => a.preco - b.preco);
                const vitrine = redirectOptions.slice(0, 5);

                for (const opt of vitrine) {
                    const shortLink = `${process.env.BASE_URL}/r?token=${opt.token}`;
                    // O WhatsApp obriga ter um texto no body. Usaremos o emoji e o nome do produto para contexto.
                    const vitrineText = `📦 ${opt.produto_nome}`;
                    const buttonText = `R$ ${opt.preco.toFixed(2)} - Ver Loja`;
                    
                    await sendCTAUrlMessage(from, vitrineText, buttonText, shortLink);
                    
                    // Pequeno delay para garantir ordem e evitar rate limit da Meta
                    await delay(800);
                }
            } else if (finalText) {
                // Resposta padrão (sem ofertas)
                // Salva a resposta da IA no histórico
                await supabase.from('historico_mensagens').insert({
                    whatsapp: from,
                    role: 'model',
                    content: finalText
                });

                console.log(`[WhatsApp] Disparando sendTextMessage para ${from}...`);
                await sendTextMessage(from, finalText);
                console.log(`[WhatsApp] Mensagem enviada fisicamente para a Meta sem falhas!`);
            }
            break;
        }

        const functionResponses = await Promise.all(
            functionCalls.map(async (fc) => {
                // Segurança: Se for geração de link e tivermos o perfil, garante o uso do UUID (ID) correto
                if (fc.name === 'gerar_link_redirecionamento' && perfil?.id) {
                    (fc.args as any).usuario_id = perfil.id;
                }

                console.log(`[Gemini] Chamando skill: ${fc.name}`, fc.args);
                const result = await executarSkill(fc.name!, fc.args as Record<string, unknown>);
                
                // Coleta dados de redirecionamento para agrupar depois
                if (fc.name === 'gerar_link_redirecionamento') {
                    redirectOptions.push({ ...result, ...fc.args });
                }

                return { name: fc.name!, response: { result } };
            })
        );

        response = await chat.sendMessage({
            message: functionResponses.map(fr => ({ functionResponse: fr }))
        });
    }
}
