import { GoogleGenAI, Type, Part } from '@google/genai';
import { sendTextMessage, downloadMedia, sendInteractiveButtons, sendListMessage, sendCTAUrlMessage, type WhatsAppMessage } from '../lib/whatsapp.js';
import { detectarEstadoPorWhatsApp } from '../lib/location.js';
import { lerEstado, limparEstado, salvarEstado, obterRedis } from '../lib/redis-cloud.js';
import { supabase } from '../lib/supabase.js';
import { EstadosFluxo } from './types.js';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
const GEMINI_MODEL = 'gemini-2.5-flash';
const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

const MENU_PRINCIPAL_LIST = {
    sections: [
        {
            title: 'Gestão de Estoque',
            rows: [
                { id: 'menu_cadastrar', title: 'Cadastrar/Atualizar', description: 'Adicionar ou atualizar produtos do catálogo' },
            ]
        },
        {
            title: 'Ofertas',
            rows: [
                { id: 'menu_ofertas', title: 'Criar Ofertas', description: 'Criar desconto por ticket mínimo' },
                { id: 'menu_ver_ativas', title: 'Ver Ofertas Ativas', description: 'Listar ofertas cadastradas' },
            ]
        },
        {
            title: 'Estatísticas',
            rows: [
                { id: 'menu_estatisticas', title: 'Ver Estatísticas', description: 'Saldo de cliques e ranking' },
            ]
        }
    ]
};

async function enviarMenu(lojaNome: string, from: string) {
    await sendListMessage(
        from,
        `Olá ${lojaNome}! O que você gostaria de fazer hoje?`,
        'Escolha uma opção',
        MENU_PRINCIPAL_LIST.sections
    );
}

async function buscarPerfilLoja(whatsapp: string) {
    const whatsappNormalizado = whatsapp.replace(/\D/g, '');
    let { data } = await supabase
        .from('lojas')
        .select('id, nome, cidade, bairro, estado, saldo_cliques, ativa')
        .eq('whatsapp', '+' + whatsappNormalizado)
        .single();
    if (!data) {
        ({ data } = await supabase
            .from('lojas')
            .select('id, nome, cidade, bairro, estado, saldo_cliques, ativa')
            .eq('whatsapp', whatsappNormalizado)
            .single());
    }
    return data ?? null;
}

const toolsLojista = [
    {
        functionDeclarations: [
            {
                name: 'buscar_produtos_similares',
                description: 'Busca produtos similares no catálogo da loja usando um termo de busca.',
                parameters: {
                    type: Type.OBJECT,
                    properties: {
                        loja_id: { type: Type.STRING },
                        termo_busca: { type: Type.STRING },
                        itens: { type: Type.ARRAY },
                        fonte_ingestao: { type: Type.STRING },
                        produto_nome: { type: Type.STRING },
                        novo_preco: { type: Type.NUMBER },
                        disponivel: { type: Type.BOOLEAN },
                        valor_minimo: { type: Type.NUMBER },
                        percentual: { type: Type.NUMBER },
                        validade: { type: Type.STRING },
                        produto_filtro: { type: Type.STRING },
                    },
                    required: ['loja_id', 'termo_busca'],
                },
            },
        ],
    },
];

interface DadosProduto {
    nome: string;
    preco: number;
    unidade: string;
}

interface DadosOferta {
    valor_minimo: number;
    percentual: number;
    validade: string;
    produto_filtro?: string;
}

interface ContextoSessao {
    estado: EstadosFluxo;
    dadosProduto?: DadosProduto;
    dadosOferta?: DadosOferta;
    acao?: string;
    perguntaPendente?: string;
    termoBusca?: string;
    similaresEncontrados?: Array<{ id: string; produto_nome: string; preco: number; unidade: string }>;
}

async function salvarContexto(from: string, contexto: ContextoSessao) {
    const redis = await obterRedis();
    await redis.set(`contexto:${from}`, JSON.stringify(contexto), 'EX', 1800);
}

async function lerContexto(from: string): Promise<ContextoSessao | null> {
    const redis = await obterRedis();
    const data = await redis.get(`contexto:${from}`);
    return data ? JSON.parse(data) : null;
}

async function limparContexto(from: string) {
    const redis = await obterRedis();
    await redis.del(`contexto:${from}`);
}

function detectarFuga(texto: string, temContextoPendente: boolean = false): boolean {
    if (!temContextoPendente) {
        const frasesMenu = ['menu', 'sair'];
        const textoLower = texto.toLowerCase().trim();
        for (const frase of frasesMenu) {
            if (textoLower === frase) return true;
        }
        return false;
    }
    
    const frasesFuga = [
        'sair', 'menu', 'cancelar', 'deixa pra lá', 'nem quero', 'cancela isso',
        'desiste', 'nãoquero mais', 'voltar', 'deixa', 'cancela',
        'para tudo', 'esquece', 'deixa quieto'
    ];
    const textoLower = texto.toLowerCase().trim();
    
    for (const frase of frasesFuga) {
        if (textoLower === frase || textoLower.startsWith(frase + ' ') || textoLower.endsWith(' ' + frase)) {
            return true;
        }
    }
    return false;
}

function detectarPerguntaForaContexto(texto: string): boolean {
    const padroesPergunta = [
        'como faz', 'como faço', 'como funciona', 'como posso',
        'quanto custa', 'qual o preço', 'quanto é',
        'como pago', 'forma de pagamento', 'pagamento',
        'onde fica', 'qual o endereço', 'endereço',
        'telefone', 'contato', 'whatsapp',
        'o que é', 'o que significa',
        'help', 'ajuda', 'me ajuda'
    ];
    const textoLower = texto.toLowerCase().trim();
    for (const padrao of padroesPergunta) {
        if (textoLower.includes(padrao)) {
            return true;
        }
    }
    return false;
}

async function processarDadosProduto(from: string, loja: any, userMessageText: string, contexto: ContextoSessao) {
    console.log(`[Cenário 2/3/10] Processando dados do produto:`, userMessageText);

    const dadosExistentes = contexto.dadosProduto;
    
    const prompt = `Você é um assistente que extrai dados de produtos de mensagens informais de lojistas via WhatsApp.

${dadosExistentes?.nome ? `DADOS JÁ COLETADOS: nome="${dadosExistentes.nome}"` : ''}
${dadosExistentes?.preco ? `DADOS JÁ COLETADOS: preco=${dadosExistentes.preco}` : ''}
${dadosExistentes?.unidade ? `DADOS JÁ COLETADOS: unidade="${dadosExistentes.unidade}"` : ''}
${!dadosExistentes?.nome && !dadosExistentes?.preco && !dadosExistentes?.unidade ? 'Nenhum dado coletado ainda.' : ''}

TAREFA: Extraia nome, preco e unidade da mensagem do usuário.

Regras:
1. Se o usuário enviou APENAS um número (ex: "6", "25", "18.50"), isso é o PREÇO. Use o nome já coletado.
2. Se o usuário enviou APENAS uma unidade (ex: "kg", "un", "5kg"), isso é a UNIDADE.
3. Preços podem usar vírgula (8,50) ou ponto (8.50) - converta sempre para ponto
4. Unidades comuns: kg, g, l, ml, un, pacote, cx, lata, dúzia, dz
5. Se a mensagem tem todos os dados ou pode ser completada com os dados já coletados, retorne completo
6. Se ainda falta algo e não há como inferir, indique o que falta

Retorne APENAS JSON. Mesmo quando incompleto, inclua TODOS os campos que conseguiu extrair:
- Se completo: {"incompleto": false, "nome": "Feijão", "preco": 18.00, "unidade": "kg"}
- Se falta preço: {"incompleto": true, "falta": "preco", "nome": "Feijão", "unidade": "kg"}
- Se falta nome: {"incompleto": true, "falta": "nome", "preco": 18.00, "unidade": "kg"}
- Se falta unidade: {"incompleto": true, "falta": "unidade", "nome": "Feijão", "preco": 18.00}

Mensagem do usuário: "${userMessageText}"

JSON:`;

    try {
        const result = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: prompt,
            config: { responseMimeType: 'application/json' },
        });
        const text = result.text || '';
        console.log(`[Debug] Resposta Gemini:`, text);
        
        try {
            const dados = JSON.parse(text);
            
            if (dados.incompleto) {
                console.log(`[Cenário 10] Dados incompletos - perguntando por:`, dados.falta);
                let pergunta = '';
                if (dados.falta === 'preco') {
                    const nome = dadosExistentes?.nome || dados.nome || 'produto';
                    pergunta = `Faltou o valor. Qual é o preço do ${nome}?`;
                } else if (dados.falta === 'nome') {
                    pergunta = 'Faltou o nome do produto. Qual é o produto?';
                } else if (dados.falta === 'unidade') {
                    pergunta = 'Qual a unidade (kg, g, un, etc)?';
                }
                
                await salvarContexto(from, {
                    ...contexto,
                    dadosProduto: { nome: dados.nome || dadosExistentes?.nome || '', preco: dados.preco || dadosExistentes?.preco || 0, unidade: dados.unidade || dadosExistentes?.unidade || '' },
                    perguntaPendente: pergunta
                });
                await sendTextMessage(from, pergunta);
                return;
            }

            const produto: DadosProduto = {
                nome: dados.nome || dadosExistentes?.nome || '',
                preco: dados.preco || dadosExistentes?.preco || 0,
                unidade: dados.unidade || dadosExistentes?.unidade || 'un'
            };

            console.log(`[Debug] Produto extraído:`, produto);

            const similares = await buscarProdutosSimilares({ loja_id: loja.id, termo_busca: produto.nome });
            
            if (similares.length > 0) {
                console.log(`[Cenário 3] Encontrados`, similares.length, 'produtos similares');
                
                let listaMsg = '🔍 Encontrei produtos parecidos. Responda com o NÚMERO:\n\n';
                
                for (let i = 0; i < similares.length; i++) {
                    const s = similares[i];
                    listaMsg += `${i + 1} - ${s.produto_nome} (R$ ${s.preco} ${s.unidade})\n`;
                }
                
                listaMsg += '\n0 - Nenhum (cadastrar novo)';
                
                await salvarContexto(from, {
                    estado: EstadosFluxo.AGUARDANDO_ACAO_SIMILARES,
                    dadosProduto: produto,
                    similaresEncontrados: similares,
                    acao: 'cadastrar'
                });
                
                await sendTextMessage(from, listaMsg);
                return;
            } else {
                console.log(`[Cenário 2/5] Nenhum similar - cadastrando novo`);
                await ingeriCatalogo({
                    loja_id: loja.id,
                    itens: [{ produto_nome: produto.nome, preco: produto.preco, unidade: produto.unidade }],
                    fonte_ingestao: 'manual'
                });
                await sendTextMessage(from, `✅ Produto '${produto.nome} ${produto.unidade}' cadastrado com sucesso!`);
                await limparContexto(from);
                await enviarMenu(loja.nome, from);
                return;
            }
        } catch (jsonError) {
            console.log(`[Erro] JSON inválido na resposta:`, jsonError);
        }
    } catch (e) {
        console.log(`[Erro processamento]`, e);
    }

    await sendTextMessage(from, "Não consegui entender os dados. Por favor, digite: Nome do produto, Preço e Unidade.");
    return;
}

export async function processMessage(msg: WhatsAppMessage): Promise<void> {
    const from = msg.from;
    console.log(`[Debug] Mensagem de: ${from}`);
    
    const loja = await buscarPerfilLoja(from);
    if (!loja) {
        console.log(`[Debug] Número não cadastrado como lojista`);
        return;
    }

    const contexto = await lerContexto(from);
    
    const isMediaOnly = msg.type === 'image' || msg.type === 'audio' || msg.type === 'sticker';
    const isTextOnly = msg.type === 'text';
    const isInteractive = msg.type === 'interactive';
    
    const userMessageText = msg.text?.body || 
        (msg.type === 'interactive' ? msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title : '') || '';
    
    const buttonId = isInteractive ? (msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id || '') : '';
    
    console.log(`[Debug] Contexto atual:`, contexto?.estado);
    console.log(`[Debug] Mensagem:`, userMessageText || `[${msg.type}]`);

    // Processa cliques do menu PRIMEIRO (antes de verificar IDLE)
    if (isInteractive && buttonId.startsWith('menu_')) {
        const acao = buttonId.replace('menu_', '');
        
        if (acao === 'cadastrar') {
            console.log(`[Cenário 2] Iniciando fluxo de cadastro`);
            await salvarContexto(from, {
                estado: EstadosFluxo.AGUARDANDO_DADOS_PRODUTO,
                acao: 'cadastrar',
                perguntaPendente: 'Por favor, digite o Nome do produto, Preço e Unidade (ex: Manteiga Aviação 15.00 200g)'
            });
            await sendTextMessage(from, "Por favor, digite o Nome do produto, Preço e Unidade (ex: Manteiga Aviação 15.00 200g)");
            return;
        }
        
        if (acao === 'ofertas') {
            console.log(`[Cenário] Iniciando fluxo de oferta`);
            await salvarContexto(from, {
                estado: EstadosFluxo.AGUARDANDO_DADOS_OFERTA,
                acao: 'criar_oferta',
                perguntaPendente: 'Para criar uma oferta, preciso saber: Valor mínimo do ticket (R$), Percentual de desconto (%), e Data de validade (YYYY-MM-DD). Envie todos os dados.'
            });
            await sendTextMessage(from, "Para criar uma oferta, preciso saber: Valor mínimo do ticket (R$), Percentual de desconto (%), e Data de validade (YYYY-MM-DD). Envie todos os dados.");
            return;
        }
        
        if (acao === 'estatisticas') {
            const stats = await obterEstatisticas({ loja_id: loja.id });
            await sendTextMessage(from, `📊 Estatísticas da loja:\n\nSaldo de cliques: ${stats.saldo}\nStatus: ${stats.status}\nCliques (30 dias): ${stats.cliques_30d}`);
            await delay(500);
            await enviarMenu(loja.nome, from);
            return;
        }
        
        if (acao === 'ver_ativas') {
            const ofertas = await buscarOfertasAtivas({ loja_id: loja.id });
            if (ofertas.length === 0) {
                await sendTextMessage(from, "Você não tem ofertas ativas no momento.");
            } else {
                let texto = "📢 Suas ofertas ativas:\n\n";
                for (const o of ofertas) {
                    texto += `• ${o.valor_minimo} → ${o.percentual}% off (até ${o.validade})\n`;
                }
                await sendTextMessage(from, texto);
            }
            await delay(500);
            await enviarMenu(loja.nome, from);
            return;
        }
    }

    // CENÁRIO 1/8/12: Estado IDLE - ignora ruídos e cliques fantasmas
    if (!contexto || contexto.estado === EstadosFluxo.IDLE) {
        if (isMediaOnly) {
            console.log(`[Cenário 8] Mídia no IDLE - ignorando`);
            await sendTextMessage(from, "Bela foto! 📸 Mas para continuarmos, por favor, escolha uma das opções no menu abaixo:");
            await delay(500);
            await enviarMenu(loja.nome, from);
            return;
        }

        if (isTextOnly && userMessageText.trim()) {
            console.log(`[Cenário 1] Texto no IDLE - ignorando, enviando menu`);
            await enviarMenu(loja.nome, from);
            return;
        }

        if (isInteractive) {
            console.log(`[Cenário 12] Clique fantasma detectado`);
            await sendTextMessage(from, "⏳ Parece que essa operação expirou ou já foi concluída. Vamos começar de novo!");
            await delay(500);
            await enviarMenu(loja.nome, from);
            return;
        }

        await enviarMenu(loja.nome, from);
        return;
    }

    // CENÁRIO 2/3/10/11: Fluxo de cadastro de produto
    if (contexto?.estado === EstadosFluxo.AGUARDANDO_DADOS_PRODUTO) {
        if (detectarFuga(userMessageText, true)) {
            console.log(`[Cenário 6] Fuga detectada`);
            await limparContexto(from);
            await sendTextMessage(from, "Operação cancelada sem alterações.");
            await delay(500);
            await enviarMenu(loja.nome, from);
            return;
        }

        if (detectarPerguntaForaContexto(userMessageText)) {
            console.log(`[Cenário 9] Pergunta fora de contexto detectada`);
            await sendTextMessage(from, `Podemos falar sobre isso depois! Mas agora, não consegui identificar os dados. Por favor, envie o Nome, Preço e Unidade do produto que estávamos cadastrando. (Ou digite 'Cancelar' para sair).`);
            return;
        }

        if (!userMessageText.trim()) {
            if (isMediaOnly) {
                console.log(`[Cenário 11] Mídia recebida no fluxo de dados`);
                const mediaId = (msg as any).image?.id || (msg as any).document?.id;
                if (!mediaId) {
                    await sendTextMessage(from, "Não consegui processar este tipo de mídia. Pode digitar o Nome, Preço e Unidade do produto?");
                    return;
                }
                const buffer = await downloadMedia(mediaId);
                const base64 = buffer.toString('base64');
                
                const prompt = `Extraia informações de produtos desta imagem. Responda APENAS com um objeto JSON, sem texto adicional.

Se conseguir ler: {"nome": "...", "preco": numero, "unidade": "..."}
Se não conseguir ler: {"erro": "nao_consegui"}`;
                
                const imgPart: Part = { inlineData: { data: base64, mimeType: 'image/jpeg' } };
                
                try {
                    const result = await ai.models.generateContent({
                        model: GEMINI_MODEL,
                        contents: [{ text: prompt }, imgPart],
                        config: { responseMimeType: 'application/json' },
                    });
                    const text = result.text || '';
                    console.log(`[Debug] OCR Gemini:`, text);
                    const dados = JSON.parse(text);
                    if (dados.erro) {
                        await sendTextMessage(from, "A foto ficou um pouco desfocada e não consegui ler o preço. 🧐 Pode digitar o Nome, Preço e Unidade para mim?");
                        return;
                    }
                    await salvarContexto(from, {
                        ...contexto,
                        dadosProduto: { nome: dados.nome || '', preco: dados.preco || 0, unidade: dados.unidade || '' }
                    });
                    const textoProcessado = `${dados.nome || ''} ${dados.preco || ''} ${dados.unidade || ''}`.trim();
                    await processarDadosProduto(from, loja, textoProcessado, contexto);
                    return;
                } catch (e) {
                    console.log(`[Erro OCR]`, e);
                    await sendTextMessage(from, "A foto ficou um pouco desfocada e não consegui ler o preço. 🧐 Pode digitar o Nome, Preço e Unidade para mim?");
                    return;
                }
            }
            return;
        }

        await processarDadosProduto(from, loja, userMessageText, contexto);
        return;
    }

    // CENÁRIO 3/4/5/7: Escolha de produto similar (número)
    if (contexto?.estado === EstadosFluxo.AGUARDANDO_ACAO_SIMILARES) {
        if (detectarFuga(userMessageText, true)) {
            console.log(`[Cenário 6] Fuga detectada`);
            await limparContexto(from);
            await sendTextMessage(from, "Operação cancelada sem alterações.");
            await delay(500);
            await enviarMenu(loja.nome, from);
            return;
        }

        if (detectarPerguntaForaContexto(userMessageText)) {
            console.log(`[Cenário 9] Pergunta fora de contexto detectada`);
            await sendTextMessage(from, `Podemos falar sobre isso depois! Mas agora, não consegui identificar a opção. Por favor, responda com o número (1, 2...) ou '0' para produto novo. (Ou digite 'Cancelar' para sair).`);
            return;
        }

        const textoNum = userMessageText.trim().toLowerCase();
        const opcaoNum = parseInt(textoNum);
        
        const mapaPalavras: Record<string, number> = {
            'nenhum': 0, 'nenhum desses': 0, 'é novo': 0, 'novo': 0, 'outro': 0, 'zero': 0, '0': 0,
            'primeiro': 1, 'um': 1, '1': 1,
            'segundo': 2, 'dois': 2, '2': 2,
            'terceiro': 3, 'três': 3, '3': 3,
            'quarto': 4, 'quatro': 4, '4': 4,
            'quinto': 5, 'cinco': 5, '5': 5
        };

        let opcaoEscolhida = opcaoNum;
        
        if (isNaN(opcaoNum) && textoNum) {
            const opcao = mapaPalavras[textoNum];
            if (opcao !== undefined) {
                opcaoEscolhida = opcao;
            }
        }

        const similares = contexto.similaresEncontrados || [];
        
        if (opcaoEscolhida === 0) {
            console.log(`[Cenário 5] Usuário escolheu opção 0 - cadastrar novo`);
            const produto = contexto.dadosProduto!;
            await ingeriCatalogo({
                loja_id: loja.id,
                itens: [{ produto_nome: produto.nome, preco: produto.preco, unidade: produto.unidade }],
                fonte_ingestao: 'manual'
            });
            await sendTextMessage(from, `✅ Produto '${produto.nome} ${produto.unidade}' cadastrado com sucesso!`);
            await limparContexto(from);
            await delay(500);
            await enviarMenu(loja.nome, from);
            return;
        }

        if (opcaoEscolhida > 0 && opcaoEscolhida <= similares.length) {
            const prod = similares[opcaoEscolhida - 1];
            const novoPreco = contexto.dadosProduto?.preco;
            
            if (!novoPreco) {
                await sendTextMessage(from, "Não tenho o novo preço para atualizar. Por favor, digite o produto novamente.");
                await limparContexto(from);
                await delay(500);
                await enviarMenu(loja.nome, from);
                return;
            }
            
            await salvarContexto(from, {
                ...contexto,
                estado: EstadosFluxo.AGUARDANDO_ACAO_PRODUTO_SELECIONADO,
                dadosProduto: { nome: prod.produto_nome, preco: novoPreco, unidade: prod.unidade }
            });
            
            await sendInteractiveButtons(from, `Selecionado: ${prod.produto_nome} (R$ ${prod.preco} ${prod.unidade}). O que deseja fazer?`, [
                { id: 'acao_atualizar', title: 'Atualizar Valor' },
                { id: 'acao_retirar', title: 'Retirar do Estoque' }
            ]);
            return;
        }

        console.log(`[Cenário 7] Opção inválida`);
        await sendTextMessage(from, `Desculpe, não encontrei essa opção. Digite apenas o número correspondente na lista (ex: 1 ou 2) ou '0' para produto novo.`);
        return;
    }

    // CENÁRIO 3/4: Ação após selecionar produto (Atualizar ou Retirar)
    if (contexto?.estado === EstadosFluxo.AGUARDANDO_ACAO_PRODUTO_SELECIONADO) {
        if (detectarFuga(userMessageText, true)) {
            console.log(`[Cenário 6] Fuga detectada`);
            await limparContexto(from);
            await sendTextMessage(from, "Operação cancelada sem alterações.");
            await delay(500);
            await enviarMenu(loja.nome, from);
            return;
        }

        if (isInteractive && (buttonId === 'acao_atualizar' || buttonId === 'acao_retirar')) {
            const produto = contexto.dadosProduto!;
            
            if (buttonId === 'acao_atualizar') {
                console.log(`[Cenário 3] Atualizando preço`);
                await atualizarPreco({ loja_id: loja.id, produto_nome: produto.nome, novo_preco: produto.preco });
                await sendTextMessage(from, `✅ Preço atualizado com sucesso para R$ ${produto.preco}!`);
            } else {
                console.log(`[Cenário 4] Retirando do estoque`);
                await atualizarDisponibilidade({ loja_id: loja.id, produto_nome: produto.nome, disponivel: false });
                await sendTextMessage(from, `✅ Produto '${produto.nome}' retirado do estoque e oculto das buscas!`);
            }
            
            await limparContexto(from);
            await delay(500);
            await enviarMenu(loja.nome, from);
            return;
        }

        await sendTextMessage(from, "Por favor, escolha uma das opções abaixo:");
        await delay(300);
        await sendInteractiveButtons(from, `O que deseja fazer com ${contexto.dadosProduto?.nome}?`, [
            { id: 'acao_atualizar', title: 'Atualizar Valor' },
            { id: 'acao_retirar', title: 'Retirar do Estoque' }
        ]);
        return;
    }

    // CENÁRIO: Fluxo de oferta
    if (contexto?.estado === EstadosFluxo.AGUARDANDO_DADOS_OFERTA) {
        if (detectarFuga(userMessageText, true)) {
            console.log(`[Cenário 6] Fuga detectada`);
            await limparContexto(from);
            await sendTextMessage(from, "Operação cancelada sem alterações.");
            await delay(500);
            await enviarMenu(loja.nome, from);
            return;
        }

        if (detectarPerguntaForaContexto(userMessageText)) {
            console.log(`[Cenário 9] Pergunta fora de contexto detectada`);
            await sendTextMessage(from, `Podemos falar sobre isso depois! Mas agora, não consegui identificar os dados da oferta. Por favor, envie: Valor mínimo (R$), Percentual (%), Data de validade. (Ou digite 'Cancelar' para sair).`);
            return;
        }

        if (isInteractive) {
            return;
        }

        console.log(`[Cenário] Processando dados da oferta:`, userMessageText);

        const prompt = `Extraia os dados da oferta de desconto. Responda APENAS com um objeto JSON, sem texto adicional.

Regras:
1. Valor mínimo pode usar vírgula (8,50) ou ponto (8.50)
2. Percentual é um número de 0 a 100
3. Data de validade no formato YYYY-MM-DD ou DD/MM/AAAA
4. Pode ter filtro de produto (opcional)

Retorne APENAS: {"valor_minimo": numero, "percentual": numero, "validade": "YYYY-MM-DD", "produto_filtro": "string ou null"}

Mensagem: "${userMessageText}"

JSON:`;

        try {
            const result = await ai.models.generateContent({
                model: GEMINI_MODEL,
                contents: prompt,
                config: { responseMimeType: 'application/json' },
            });
            const text = result.text || '';
            console.log(`[Debug] Resposta Gemini oferta:`, text);
            const dados = JSON.parse(text);
            
            await criarOferta({
                loja_id: loja.id,
                valor_minimo: dados.valor_minimo,
                percentual: dados.percentual,
                validade: dados.validade,
                produto_filtro: dados.produto_filtro
            });
            
            await sendTextMessage(from, `✅ Oferta criada! ${dados.percentual}% de desconto para compras acima de R$ ${dados.valor_minimo}. Válido até ${dados.validade}`);
            await limparContexto(from);
            await delay(500);
            await enviarMenu(loja.nome, from);
            return;
        } catch (e) {
            console.log(`[Erro processamento oferta]`, e);
        }

        await sendTextMessage(from, "Não consegui entender. Envie: Valor mínimo (R$), Percentual (%), Data de validade (YYYY-MM-DD).");
        return;
    }

    console.log(`[Debug] Mensagem não tratada, enviando menu`);
    await enviarMenu(loja.nome, from);
}

async function buscarProdutosSimilares(args: { loja_id: string; termo_busca: string }) {
    const { data, error } = await supabase
        .from('catalogo_historico')
        .select('id, produto_nome, preco, unidade, disponivel')
        .eq('loja_id', args.loja_id)
        .eq('disponivel', true)
        .order('registrado_em', { ascending: false });
    if (error) throw error;
    
    if (!data || data.length === 0) return [];

    const catalogList = data.map((p: any, i: number) => `${i + 1}. ${p.produto_nome} (R$ ${p.preco} ${p.unidade})`).join('\n');

    const prompt = `Você é um especialista em busca de produtos. Encontre TODOS os produtos semanticamente similares ao termo de busca na lista do catálogo.

Termo de busca: "${args.termo_busca}"

Catálogo disponível:
${catalogList}

Regras:
1. Considere variações de acento (feijao = feijão)
2. Considere sinônimos e variações (arroz = arroz integral, feijão = feijão preto)
3. Considere marcas diferentes do mesmo produto
4. Retorne TODOS os produtos similares, não apenas alguns
5. Ordene por relevância (mais similar primeiro)
6. Se não houver nenhum similar, retorne lista vazia

Retorne APENAS um array JSON com os índices dos produtos similares ordenados por relevância.
Exemplo: [3, 1, 7] significa que os produtos nas posições 3, 1 e 7 são similares.

JSON:`;

    try {
        const result = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: prompt,
            config: { responseMimeType: 'application/json' },
        });
        const text = result.text || '';
        console.log(`[Debug] Gemini busca similares:`, text);
        
        const indices = JSON.parse(text);
        if (!Array.isArray(indices)) return [];
        
        return indices
            .filter((idx: number) => idx >= 1 && idx <= data.length)
            .map((idx: number) => data[idx - 1]);
    } catch (e) {
        console.log(`[Erro] Gemini na busca de similares:`, e);
        return [];
    }
}

async function ingeriCatalogo(args: { loja_id: string; itens: any[]; fonte_ingestao: string }) {
    if (!args.itens?.length) return { sucesso: false };
    const payload = args.itens.map(item => ({
        loja_id: args.loja_id,
        produto_nome: item.produto_nome,
        preco: item.preco,
        unidade: item.unidade ?? 'un',
        disponivel: true,
        fonte_ingestao: args.fonte_ingestao,
    }));
    const { error } = await supabase.from('catalogo_historico').insert(payload);
    if (error) throw error;
    return { sucesso: true, inseridos: payload.length };
}

async function atualizarPreco(args: { loja_id: string; produto_nome: string; novo_preco: number }) {
    const { data: produto } = await supabase
        .from('catalogo_historico')
        .select('id')
        .eq('loja_id', args.loja_id)
        .ilike('produto_nome', `%${args.produto_nome}%`)
        .eq('disponivel', true)
        .order('registrado_em', { ascending: false })
        .limit(1)
        .single();
    if (!produto) throw new Error('Produto não encontrado');
    const { error } = await supabase.from('catalogo_historico').update({ preco: args.novo_preco }).eq('id', produto.id);
    if (error) throw error;
    return { sucesso: true };
}

async function atualizarDisponibilidade(args: { loja_id: string; produto_nome: string; disponivel: boolean }) {
    const { data: produto } = await supabase
        .from('catalogo_historico')
        .select('id')
        .eq('loja_id', args.loja_id)
        .ilike('produto_nome', `%${args.produto_nome}%`)
        .order('registrado_em', { ascending: false })
        .limit(1)
        .single();
    if (!produto) throw new Error('Produto não encontrado');
    const { error } = await supabase.from('catalogo_historico').update({ disponivel: args.disponivel }).eq('id', produto.id);
    if (error) throw error;
    return { sucesso: true };
}

async function obterEstatisticas(args: { loja_id: string }) {
    const { data: loja } = await supabase.from('lojas').select('saldo_cliques, ativa').eq('id', args.loja_id).single();
    const trintaDiasAtras = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { count } = await supabase.from('cliques_consumidos').select('*', { count: 'exact', head: true }).eq('loja_id', args.loja_id).eq('debitado', true).gte('consumido_em', trintaDiasAtras);
    return { saldo: loja?.saldo_cliques ?? 0, status: loja?.ativa ? 'Ativa' : 'Pausada', cliques_30d: count || 0 };
}

async function criarOferta(args: { loja_id: string; valor_minimo: number; percentual: number; validade: string; produto_filtro?: string }) {
    const { error } = await supabase.from('ofertas_desconto').insert({
        loja_id: args.loja_id,
        valor_minimo: args.valor_minimo,
        percentual: args.percentual,
        validade: args.validade,
        produto_filtro: args.produto_filtro || null,
    });
    if (error) throw error;
    return { sucesso: true };
}

async function buscarOfertasAtivas(args: { loja_id: string }) {
    const hoje = new Date().toISOString().split('T')[0];
    const { data, error } = await supabase
        .from('ofertas_desconto')
        .select('id, valor_minimo, percentual, validade, produto_filtro')
        .eq('loja_id', args.loja_id)
        .gte('validade', hoje)
        .order('validade', { ascending: true });
    if (error) throw error;
    return data || [];
}
