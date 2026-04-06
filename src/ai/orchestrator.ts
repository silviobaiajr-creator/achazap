import { GoogleGenAI, Type, Part } from '@google/genai';
import {
    sendTextMessage,
    downloadMedia,
    sendInteractiveButtons,
    sendListMessage,
    sendCTAUrlMessage,
    type WhatsAppMessage,
} from '../lib/whatsapp.js';
import {
    lerContexto,
    limparContexto,
    salvarContexto,
    renovarTTLContexto,
    adquirirLock,
    liberarLock,
    getRedisCloudClient,
} from '../lib/redis-cloud.js';
import { supabase } from '../lib/supabase.js';
import { EstadosFluxo } from './types.js';
import { logger, logTokens } from '../lib/logger.js';
import {
    ProdutoExtraidoSchema,
    IndicesSimilaresSchema,
    NLPEscolhaSchema,
    FugaNLPSchema,
    MultimodalExtraidoSchema,
    OfertaExtraidaSchema,
    parseSafe,
} from './schemas.js';

const ai          = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
const GEMINI_MODEL = 'gemini-2.5-flash';
const delay        = (ms: number) => new Promise(res => setTimeout(res, ms));

// ============================================================
// TIPOS
// ============================================================
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
    dadosProduto?: Partial<DadosProduto>;
    dadosOferta?: Partial<DadosOferta>;
    acao?: string;
    perguntaPendente?: string;
    termoBusca?: string;
    similaresEncontrados?: Array<{ id: string; produto_nome: string; preco: number; unidade: string }>;
    retries?: number;  // Sprint 10: contador anti-loop
}

// ============================================================
// MENU PRINCIPAL
// ============================================================
const MENU_SECTIONS = [
    {
        title: 'Gestão de Estoque',
        rows: [{ id: 'menu_cadastrar', title: 'Cadastrar/Atualizar', description: 'Adicionar ou atualizar produtos' }],
    },
    {
        title: 'Ofertas',
        rows: [
            { id: 'menu_ofertas',     title: 'Criar Ofertas',    description: 'Desconto por ticket mínimo' },
            { id: 'menu_ver_ativas',  title: 'Ver Ofertas Ativas', description: 'Listar ofertas cadastradas' },
        ],
    },
    {
        title: 'Estatísticas',
        rows: [{ id: 'menu_estatisticas', title: 'Ver Estatísticas', description: 'Saldo de cliques e ranking' }],
    },
];

// Sprint 1 #14: truncate de 24 chars no nome da loja (limite da Meta)
async function enviarMenu(lojaNome: string, from: string): Promise<void> {
    const nomeSeguro = lojaNome.substring(0, 24);
    try {
        await sendListMessage(from, `Olá ${nomeSeguro}! O que você gostaria de fazer hoje?`, 'Escolha uma opção', MENU_SECTIONS);
    } catch (err: any) {
        // Sprint 1 #15: fallback texto simples para WhatsApp antigo / listas não suportadas
        logger.warn({ err: err?.message, from }, '[enviarMenu] Lista interativa falhou, enviando fallback texto');
        await sendTextMessage(
            from,
            `Olá ${nomeSeguro}! O que você gostaria de fazer?\n\n` +
            `1 - Cadastrar/Atualizar produto\n` +
            `2 - Criar Ofertas\n` +
            `3 - Ver Ofertas Ativas\n` +
            `4 - Ver Estatísticas\n\n` +
            `Digite o número da opção desejada.`
        );
    }
}

// ============================================================
// PERFIL DA LOJA (com cache Redis — C1)
// ============================================================
async function buscarPerfilLoja(whatsapp: string) {
    const redis = getRedisCloudClient();
    const cacheKey = `loja:${whatsapp}`;

    try {
        const cached = await redis.get(cacheKey);
        if (cached) return JSON.parse(cached);
    } catch { /* ignora falha de cache */ }

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

    if (data) {
        try { await redis.set(cacheKey, JSON.stringify(data), 'EX', 300); } catch { /* ignora */ }
    }
    return data ?? null;
}

// ============================================================
// MIDDLEWARE GLOBAL DE FUGA — Sprint 6 #1
// Deve ser chamado ANTES da máquina de estados
// ============================================================
const PALAVRAS_FUGA = /^(menu|cancelar|sair|voltar|reiniciar|cancela|cancela isso|para tudo|esquece|deixa pra lá|nem quero|não quero mais)$/i;
const IDS_BOTAO_FUGA = new Set(['btn_menu', 'btn_cancelar', 'acao_menu', 'menu_principal']);

async function verificarFugaGlobal(
    msg: WhatsAppMessage,
    buttonId: string,
    userText: string,
    contexto: ContextoSessao | null,
    from: string,
    loja: any
): Promise<boolean> {
    // Nível 0: só faz sentido se há contexto ativo
    const temContextoAtivo = contexto !== null && contexto.estado !== EstadosFluxo.IDLE;

    // Nível 1: botão interativo de fuga (Sprint 6 #4)
    if (msg.type === 'interactive' && IDS_BOTAO_FUGA.has(buttonId)) {
        await executarFuga(from, loja);
        return true;
    }

    // Nível 2: regex de palavras exatas — custo zero (Sprint 6 #2)
    if (userText && PALAVRAS_FUGA.test(userText.trim())) {
        await executarFuga(from, loja);
        return true;
    }

    // Nível 3: NLP para frases coloquiais (apenas se há contexto ativo)
    if (temContextoAtivo && userText && userText.length > 3) {
        const ehFuga = await detectarFugaNLP(userText);
        if (ehFuga) {
            await executarFuga(from, loja);
            return true;
        }
    }

    return false;
}

async function detectarFugaNLP(texto: string): Promise<boolean> {
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

async function executarFuga(from: string, loja: any): Promise<void> {
    await limparContexto(from); // Sprint 6 #3: expurgo total — zero zumbis
    await sendTextMessage(from, 'Sem problemas! Operação cancelada. 🧹 O que gostaria de fazer agora?');
    await delay(300);
    await enviarMenu(loja.nome, from);
}

// ============================================================
// PROCESSAMENTO DE DADOS DO PRODUTO (Cenários 2/3/10)
// ============================================================
async function processarDadosProduto(from: string, loja: any, userMessageText: string, contexto: ContextoSessao): Promise<void> {
    logger.debug({ from, userMessageText }, '[Cenário 2/3/10] Processando produto');

    const dadosExistentes = contexto.dadosProduto;
    const retries = contexto.retries ?? 0;

    // Sprint 2 #1: feedback imediato UX
    try {
        const redis = getRedisCloudClient();
        await redis.call('sendReaction', from, '🔍').catch(() => {});  // best-effort
    } catch { /* ignora se API não suportar */ }

    const prompt = `Você é um extrator estrito de dados de produtos de estoque. NUNCA responda perguntas gerais. NUNCA dê conselhos. Sua única função é extrair Nome, Preço e Unidade de mensagens de lojistas.

${dadosExistentes?.nome ? `DADOS JÁ COLETADOS: nome="${dadosExistentes.nome}"` : ''}
${dadosExistentes?.preco !== undefined && dadosExistentes?.preco !== null ? `DADOS JÁ COLETADOS: preco=${dadosExistentes.preco}` : ''}
${dadosExistentes?.unidade ? `DADOS JÁ COLETADOS: unidade="${dadosExistentes.unidade}"` : ''}

TAREFA: Extraia nome, preco e unidade da mensagem.

Regras de extração:
1. Se o usuário enviou APENAS um número (ex: "6", "25", "18.50"), isso é o PREÇO. Use o nome já coletado.
2. Preços com vírgula (8,50) → converter para ponto (8.50)
3. Nome deve ser normalizado com Title Case (ex: "feijão" → "Feijão")
4. Unidade padrão se não informada: "un"
5. Truncar nome em 250 chars e unidade em 30 chars
6. No varejo, nomes atípicos existem ("Bom Ar", "Veja"). Considere o contexto comercial.
7. Se a palavra do nome for fora do contexto usual (ex: "Aros", "Pneu"), mas parecer ser um erro de digitação para algo comum (ex: "Arroz"), NÃO corrija o nome silenciosamente se for uma palavra que existe. Retorne "precisa_confirmacao": true e sugira o nome corrigido em "sugestao".

Regras de ruído:
- Se a mensagem for PURAMENTE conversacional ("vai chover?", "obrigado", "tudo bem"), retorne: {"ruido_detectado": true, "nome": null, "preco": null, "unidade": null, "incompleto": false}
- Se a mensagem contiver dados de outro produto (usuário mudou de ideia), ignore o rascunho e crie JSON novo.

Formatos de resposta:
- Completo: {"incompleto": false, "ruido_detectado": false, "nome": "Feijão Preto", "preco": 18.00, "unidade": "kg"}
- Falta preço: {"incompleto": true, "ruido_detectado": false, "falta": "preco", "nome": "Feijão Preto", "preco": null, "unidade": "kg"}
- Ruído: {"incompleto": false, "ruido_detectado": true, "nome": null, "preco": null, "unidade": null}

Mensagem do usuário: "${userMessageText}"

JSON:`;

    try {
        const result = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: prompt,
            config: { responseMimeType: 'application/json' },
        });

        const rawText = result.text || '{}';
        logTokens('extrair_produto', from, loja?.id ?? 'unknown', result.usageMetadata);
        logger.debug({ from, rawText }, '[Gemini] extração produto');

        const dados = parseSafe(ProdutoExtraidoSchema, rawText, {
            incompleto: false,
            ruido_detectado: false,
            nome: null,
            preco: null,
            unidade: null,
            precisa_confirmacao: false,
            sugestao: null,
        });

        // Sprint 9: interceptar ruído antes de processar
        if (dados.ruido_detectado === true) {
            logger.info({ from }, '[Cenário 9] Ruído detectado');
            const pendencia = contexto.perguntaPendente || 'Por favor, envie o Nome, Preço e Unidade do produto.';
            await sendTextMessage(from, `Não sei sobre isso! 😅 Sou treinado apenas para organizar a sua loja.\n\n${pendencia}`);
            await renovarTTLContexto(from); // Sprint 7 #4: preserva estado, renova TTL
            return;
        }

        // Sprint 13: "Você quis dizer...?" — confirmação sugerida pelo modelo
        if (dados.precisa_confirmacao && dados.sugestao) {
            logger.info({ from, nomeExtraido: dados.nome, sugestao: dados.sugestao }, '[Cenário 13] Sugestão Ortográfica detectada');
            
            const produtoSugerido: Partial<DadosProduto> = {
                nome: dados.sugestao,
                preco: nullSafe(dados.preco, dadosExistentes?.preco) ?? undefined,
                unidade: nullSafe(dados.unidade, dadosExistentes?.unidade) ?? undefined
            };

            await salvarContexto(from, {
                ...contexto,
                estado: EstadosFluxo.AGUARDANDO_CONFIRMACAO_NOME,
                dadosProduto: produtoSugerido, // por padrão assumimos a correcao se ele der ok
                perguntaPendente: `Você quis dizer *${dados.sugestao}*?`,
                retries: 0,
            });

            await sendInteractiveButtons(from, `🤔 Fiquei na dúvida... Você quis dizer *${dados.sugestao}*?`, [
                { id: 'btn_sugestao_sim', title: 'Sim, isso mesmo' },
                { id: 'btn_sugestao_nao', title: 'Não, digitar denovo' }
            ]);
            return;
        }

        // Sprint 10: dados incompletos → guardar rascunho
        if (dados.incompleto === true) {
            const novoRetries = retries + 1;

            // Sprint 10 #4: anti-loop — máximo 3 tentativas sem sucesso
            if (novoRetries > 3) {
                await limparContexto(from);
                await sendTextMessage(from, '⚠️ Operação cancelada: não consegui identificar os dados do produto após várias tentativas. Tente novamente pelo menu.');
                await delay(300);
                await enviarMenu(loja.nome, from);
                return;
            }

            let pergunta = '';
            if (dados.falta === 'preco') {
                const nome = dados.nome || dadosExistentes?.nome || 'produto';
                pergunta = `Faltou o valor! Qual é o preço do *${nome.substring(0, 250)}*?`;
            } else if (dados.falta === 'nome') {
                pergunta = 'Faltou o nome do produto. Qual é ele?';
            } else if (dados.falta === 'unidade') {
                pergunta = 'Qual a unidade? (kg, g, un, pacote, cx, lata...)';
            }

            // Sprint 10 #3: merge null-safe — novo dado só substitui se não for null/undefined
            const novosDados: Partial<DadosProduto> = {
                nome:    nullSafe(dados.nome,    dadosExistentes?.nome)    ?? undefined,
                preco:   nullSafe(dados.preco,   dadosExistentes?.preco)   ?? undefined,
                unidade: nullSafe(dados.unidade, dadosExistentes?.unidade) ?? undefined,
            };

            await salvarContexto(from, {
                ...contexto,
                dadosProduto: novosDados,
                perguntaPendente: pergunta,
                retries: novoRetries,
            });
            await sendTextMessage(from, pergunta);
            return;
        }

        // Sprint 10 #3: merge null-safe dos dados completos
        const produto: DadosProduto = {
            nome:    (nullSafe(dados.nome,    dadosExistentes?.nome)    ?? '').substring(0, 250),
            preco:   nullSafe(dados.preco,    dadosExistentes?.preco)   ?? 0,
            unidade: (nullSafe(dados.unidade, dadosExistentes?.unidade) ?? 'un').substring(0, 30),
        };

        logger.debug({ from, produto }, '[Debug] Produto extraído');

        // Busca similares (peneira) e continua o fluxo
        await avançarParaSimilaresOuSalvar(from, loja, contexto, produto);

    } catch (err) {
        logger.error({ err, from }, '[Erro] processarDadosProduto');
        await sendTextMessage(from, '😕 Tivemos um soluço no servidor. Por favor, tente enviar os dados novamente.');
    }
}

// ============================================================
// HELPER: merge null-safe (Sprint 10 #3)
// Novo valor só substitui o antigo se não for null/undefined
// ============================================================
function nullSafe<T>(novoValor: T | null | undefined, valorAntigo: T | null | undefined): T | null {
    if (novoValor !== null && novoValor !== undefined) return novoValor;
    return valorAntigo ?? null;
}

// ============================================================
// HELPER: Continuação do fluxo (nova inserção ou busca peneira)
// ============================================================
async function avançarParaSimilaresOuSalvar(from: string, loja: any, contexto: ContextoSessao, produto: DadosProduto) {
    const similares = await buscarProdutosSimilares(loja.id, produto.nome);

    if (similares.length > 0) {
        let listaMsg = '🔍 Encontrei produtos parecidos. Responda com o *número*:\n\n';
        for (let i = 0; i < similares.length; i++) {
            const s = similares[i];
            listaMsg += `${i + 1} - ${s.produto_nome} (R$ ${s.preco} / ${s.unidade})\n`;
        }
        listaMsg += '\n0 - Nenhum (cadastrar novo)';

        await salvarContexto(from, {
            ...contexto,
            estado: EstadosFluxo.AGUARDANDO_ACAO_SIMILARES,
            dadosProduto: produto,
            similaresEncontrados: similares,
            acao: 'cadastrar',
            retries: 0,
        });
        await sendTextMessage(from, listaMsg);
    } else {
        // Sem similares: INSERT direto
        await ingeriCatalogo(loja.id, produto);
        await sendTextMessage(from, `✅ Produto *${produto.nome}* (${produto.unidade}) a *R$ ${produto.preco}* cadastrado com sucesso!`);
        await limparContexto(from);
        await delay(400);
        await enviarMenu(loja.nome, from);
    }
}

// ============================================================
// PONTO DE ENTRADA PRINCIPAL
// ============================================================
export async function processMessage(msg: WhatsAppMessage): Promise<void> {
    const from = msg.from;

    const loja = await buscarPerfilLoja(from);
    if (!loja) {
        logger.debug({ from }, '[processMessage] Número não cadastrado como lojista');
        return;
    }

    let contexto = await lerContexto(from) as ContextoSessao | null;

    const isMediaOnly   = ['image', 'audio', 'video', 'sticker', 'voice'].includes(msg.type);
    const isInteractive = msg.type === 'interactive';
    const isTextOnly    = msg.type === 'text';

    const buttonId = isInteractive
        ? (msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id || '')
        : '';

    const userMessageText = msg.text?.body ||
        (isInteractive ? (msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '') : '') ||
        '';

    logger.debug({ from, estado: contexto?.estado ?? 'IDLE', tipo: msg.type, texto: userMessageText || '[media]' }, '[processMessage]');

    // ══════════════════════════════════════════════════════════
    // MIDDLEWARE GLOBAL DE FUGA (Sprint 6) — antes de tudo
    // ══════════════════════════════════════════════════════════
    // Só aciona se há contexto ativo (não desperdica tokens em IDLE)
    if (contexto && contexto.estado !== EstadosFluxo.IDLE) {
        const fugou = await verificarFugaGlobal(msg, buttonId, userMessageText, contexto, from, loja);
        if (fugou) return;
        // Reler contexto após fuga (contexto pode ter sido limpo)
        contexto = await lerContexto(from) as ContextoSessao | null;
    }

    // ══════════════════════════════════════════════════════════
    // BOTÕES DE NAVEGAÇÃO DO MENU (aceitos mesmo em IDLE)
    // Sprint 12 #2: classificação Ação vs Navegação
    // ══════════════════════════════════════════════════════════
    if (isInteractive && buttonId.startsWith('menu_')) {
        const acao = buttonId.replace('menu_', '');

        if (acao === 'cadastrar') {
            await salvarContexto(from, {
                estado: EstadosFluxo.AGUARDANDO_DADOS_PRODUTO,
                acao: 'cadastrar',
                perguntaPendente: 'Por favor, digite o *Nome*, *Preço* e *Unidade* do produto.\nEx: Feijão Preto 15,00 kg',
                retries: 0,
            });
            await sendTextMessage(from, 'Por favor, digite o *Nome*, *Preço* e *Unidade* do produto.\nEx: Feijão Preto 15,00 kg');
            return;
        }

        if (acao === 'ofertas') {
            await salvarContexto(from, {
                estado: EstadosFluxo.AGUARDANDO_DADOS_OFERTA,
                acao: 'criar_oferta',
                perguntaPendente: 'Envie: Valor mínimo (R$), Percentual de desconto (%) e Data de validade (DD/MM/AAAA).',
                retries: 0,
            });
            await sendTextMessage(from, 'Para criar uma oferta, envie:\n*Valor mínimo* (R$) | *Percentual* (%) | *Validade* (DD/MM/AAAA)\n\nEx: 80 reais, 10%, validade 30/04/2026');
            return;
        }

        if (acao === 'estatisticas') {
            const stats = await obterEstatisticas(loja.id);
            await sendTextMessage(from, `📊 *Estatísticas da sua loja:*\n\nSaldo de cliques: ${stats.saldo}\nStatus: ${stats.status}\nCliques (30 dias): ${stats.cliques_30d}`);
            await delay(500);
            await enviarMenu(loja.nome, from);
            return;
        }

        if (acao === 'ver_ativas') {
            const ofertas = await buscarOfertasAtivas(loja.id);
            if (ofertas.length === 0) {
                await sendTextMessage(from, 'Você não tem ofertas ativas no momento.');
            } else {
                let texto = '📢 *Suas ofertas ativas:*\n\n';
                for (const o of ofertas) {
                    texto += `• A partir de R$ ${o.valor_minimo} → ${o.percentual}% off (até ${o.validade})\n`;
                }
                await sendTextMessage(from, texto);
            }
            await delay(500);
            await enviarMenu(loja.nome, from);
            return;
        }
    }

    // ══════════════════════════════════════════════════════════
    // CENÁRIO 1/8/12: Estado IDLE
    // ══════════════════════════════════════════════════════════
    if (!contexto || contexto.estado === EstadosFluxo.IDLE) {
        // Sprint 1 #7/8: tipos de mídia ou localização em IDLE → bloquear sem baixar
        if (isMediaOnly || msg.type === 'location' || msg.type === 'contacts' || msg.type === 'document') {
            const lockAdquirido = await adquirirLock(`menu_lock:${from}`, 8);
            if (!lockAdquirido) {
                logger.info({ from }, '[Cenário 8] Rajada bloqueada (lock anti-spam)');
                return;
            }
            const resposta = msg.type === 'image' ? '📸 Bela foto! Mas para continuarmos, escolha uma opção:' :
                             msg.type === 'audio'  ? '🎵 Recebi seu áudio! Para continuarmos, escolha uma opção:' :
                             msg.type === 'sticker'? '😄 Figurinha recebida! Para continuarmos, escolha uma opção:' :
                             '📎 Arquivo recebido! Para continuarmos, escolha uma opção:';
            await sendTextMessage(from, resposta);
            await delay(300);
            await enviarMenu(loja.nome, from);
            await liberarLock(`menu_lock:${from}`);
            return;
        }

        // Sprint 12 #2/4: clique interativo de ação em IDLE = fantasma
        if (isInteractive && !buttonId.startsWith('menu_')) {
            await sendTextMessage(from, '⏳ Parece que essa operação expirou ou já foi concluída. Vamos recomeçar!');
            await delay(300);
            await enviarMenu(loja.nome, from);
            return;
        }

        // Texto em IDLE → enviar menu
        if (isTextOnly && userMessageText.trim()) {
            await enviarMenu(loja.nome, from);
            return;
        }

        await enviarMenu(loja.nome, from);
        return;
    }

    // ══════════════════════════════════════════════════════════
    // CENÁRIO 13: Confirmação semântica/ortográfica ("Você quis dizer...?")
    // ══════════════════════════════════════════════════════════
    if (contexto.estado === EstadosFluxo.AGUARDANDO_CONFIRMACAO_NOME) {
        let aceitou = false;
        let recusou = false;

        const mapsSim = ['sim', 'isso', 'correto', 'exato', 'uhum', 's', 'y'];
        const textLower = userMessageText.trim().toLowerCase();

        if (isInteractive) {
            if (buttonId === 'btn_sugestao_sim') aceitou = true;
            if (buttonId === 'btn_sugestao_nao') recusou = true;
        } else if (mapsSim.includes(textLower)) {
            aceitou = true;
        } else if (textLower === 'não' || textLower === 'nao' || textLower === 'n') {
            recusou = true;
        }

        if (aceitou) {
            await sendTextMessage(from, 'Ótimo, ajustado! 🎯');
            const p: DadosProduto = {
                nome:    (contexto.dadosProduto?.nome    ?? '').substring(0, 250),
                preco:   contexto.dadosProduto?.preco   ?? 0,
                unidade: (contexto.dadosProduto?.unidade ?? 'un').substring(0, 30),
            };

            // Nosso design resolve o merge: se faltou preço, voltamos ao LLM passando msg em branco
            if (p.preco === 0 || !p.preco) {
                await processarDadosProduto(from, loja, '', contexto); 
                return;
            }
            
            await avançarParaSimilaresOuSalvar(from, loja, contexto, p);
            return;
        }

        if (recusou) {
            await salvarContexto(from, { ...contexto, estado: EstadosFluxo.AGUARDANDO_DADOS_PRODUTO, perguntaPendente: 'Qual o Nome, Preço e Unidade corretos?' });
            await sendTextMessage(from, 'Entendi! Por favor, digite o *NOME*, *PREÇO* e *UNIDADE* corretos do produto novamente:');
            return;
        }

        // Resposta inválida - repetir botões
        await sendInteractiveButtons(from, `🤔 Fiquei na dúvida... Você quis dizer *${contexto.dadosProduto?.nome}*?`, [
            { id: 'btn_sugestao_sim', title: 'Sim, isso mesmo' },
            { id: 'btn_sugestao_nao', title: 'Não, digitar denovo' }
        ]);
        return;
    }

    // ══════════════════════════════════════════════════════════
    // CENÁRIO 2/3/10/11: Aguardando dados do produto
    // ══════════════════════════════════════════════════════════
    if (contexto.estado === EstadosFluxo.AGUARDANDO_DADOS_PRODUTO) {
        if (!userMessageText.trim() && isMediaOnly) {
            // Sprint 11: Upload de imagem/áudio para extração
            await processarMidia(msg, from, loja, contexto);
            return;
        }

        if (msg.type === 'interactive') {
            await sendTextMessage(from, 'Por favor, *digite* o nome, preço e unidade do produto. Ex: Feijão Preto 15,00 kg');
            return;
        }

        await processarDadosProduto(from, loja, userMessageText, contexto);
        return;
    }

    // ══════════════════════════════════════════════════════════
    // CENÁRIO 3/4/5/7: Aguardando seleção de produto similar
    // ══════════════════════════════════════════════════════════
    if (contexto.estado === EstadosFluxo.AGUARDANDO_ACAO_SIMILARES) {

        const textoNum = userMessageText.trim().toLowerCase();
        const opcaoNum = parseInt(textoNum, 10);
        const similares = contexto.similaresEncontrados ?? [];

        // Sprint 7 #1: validação estrita — parseInt entregou número?
        if (Number.isInteger(opcaoNum) && !isNaN(opcaoNum)) {

            // Sprint 7 #2: bloqueio Out of Bounds ANTES de qualquer acesso ao array
            if (opcaoNum < 0 || opcaoNum > similares.length) {
                await sendTextMessage(from, `⚠️ Opção inválida. Por favor, digite um número entre *0* e *${similares.length}*, ou diga "Cancelar" para sair.`);
                await renovarTTLContexto(from); // Sprint 7 #4: preserva estado
                return;
            }

            // Opção 0: cadastrar novo
            if (opcaoNum === 0) {
                const produto = contexto.dadosProduto as DadosProduto;
                await ingeriCatalogo(loja.id, produto);
                await sendTextMessage(from, `✅ Produto *${produto.nome}* (${produto.unidade}) a *R$ ${produto.preco}* cadastrado com sucesso!`);
                await limparContexto(from);
                await delay(400);
                await enviarMenu(loja.nome, from);
                return;
            }

            // Opção 1..N: produto selecionado
            const prod     = similares[opcaoNum - 1];
            const novoPreco = contexto.dadosProduto?.preco;

            if (novoPreco === null || novoPreco === undefined) {
                await sendTextMessage(from, 'Não tenho o novo preço para atualizar. Por favor, comece novamente.');
                await limparContexto(from);
                await delay(300);
                await enviarMenu(loja.nome, from);
                return;
            }

            // Sprint 3 #5: verificar se preço é igual ao atual (atualização inútil)
            if (novoPreco === prod.preco) {
                await sendTextMessage(from, `ℹ️ O produto *${prod.produto_nome}* já está registrado com o valor de R$ ${prod.preco}. Nenhuma alteração necessária!`);
                await limparContexto(from);
                await delay(300);
                await enviarMenu(loja.nome, from);
                return;
            }

            // Salva contexto com produto e preço antes de enviar botões (Sprint 3 #1)
            await salvarContexto(from, {
                ...contexto,
                estado: EstadosFluxo.AGUARDANDO_ACAO_PRODUTO_SELECIONADO,
                dadosProduto: { nome: prod.produto_nome, preco: novoPreco, unidade: prod.unidade },
            });

            await sendInteractiveButtons(from,
                `Selecionado: *${prod.produto_nome}* (atual: R$ ${prod.preco}). O que deseja fazer?`,
                [
                    { id: 'acao_atualizar', title: `Atualizar R$ ${novoPreco}` },
                    { id: 'acao_retirar',  title: 'Retirar Estoque' },
                ]
            );
            return;
        }

        // Mapa de palavras offset (Sprint 5) — sem chamar Gemini para o óbvio
        const mapaPalavras: Record<string, number> = {
            'nenhum': 0, 'nenhum desses': 0, 'novo': 0, 'outro': 0,
            'primeiro': 1, 'um': 1,
            'segundo': 2, 'dois': 2,
            'terceiro': 3, 'três': 3,
            'quarto': 4, 'quatro': 4,
            'quinto': 5, 'cinco': 5,
        };
        const mapeado = mapaPalavras[textoNum];
        if (mapeado !== undefined) {
            // Injetar como se o usuário tivesse digitado o número
            await processMessage({ ...msg, text: { body: String(mapeado) } });
            return;
        }

        // Sprint 5 #3: Fallback NLP — só se for texto não-numérico
        if (userMessageText.trim()) {
            const listaOptions = similares.map((s, i) => `${i + 1} - ${s.produto_nome}`).concat(['0 - Novo produto']);
            try {
                const result = await ai.models.generateContent({
                    model: GEMINI_MODEL,
                    contents: `O usuário recebeu as opções:\n${listaOptions.join('\n')}\n\nEle respondeu: "${userMessageText}"\n\nTraduz a intenção dele para o número correspondente. Retorne EXATAMENTE: {"escolha": inteiro, "cancelar": boolean}.\nRegras:\n1. Se a intenção for explicitamente sair/cancelar o fluxo, retorne "cancelar": true.\n2. Se ele apenas enviou algo fora do contexto/ambíguo/ruído, retorne "cancelar": false e "escolha": -1.`,
                    config: { responseMimeType: 'application/json' },
                });
                logTokens('nlp_escolha_similar', from, loja?.id ?? 'unknown', result.usageMetadata);
                const nlp = parseSafe(NLPEscolhaSchema, result.text || '{}', { escolha: -1, cancelar: false });
                
                if (nlp.cancelar === true) {
                    await executarFuga(from, loja);
                    return;
                }
                
                if (Number.isInteger(nlp.escolha) && nlp.escolha >= 0 && nlp.escolha <= similares.length) {
                    await processMessage({ ...msg, text: { body: String(nlp.escolha) } });
                    return;
                }
            } catch { /* ignora erro NLP, vai cair no fallback padrão abaixo */ }
        }

        await sendTextMessage(from, `Não entendi. Digite um número entre *0* e *${similares.length}*, ou diga "Cancelar".`);
        await renovarTTLContexto(from);
        return;
    }

    // ══════════════════════════════════════════════════════════
    // CENÁRIO 3/4: Ação após selecionar produto
    // ══════════════════════════════════════════════════════════
    if (contexto.estado === EstadosFluxo.AGUARDANDO_ACAO_PRODUTO_SELECIONADO) {
        if (isInteractive && (buttonId === 'acao_atualizar' || buttonId === 'acao_retirar')) {
            const produto = contexto.dadosProduto as DadosProduto;

            // Sprint 3 #6 / Sprint 4 #5: limpar estado ANTES do banco (race condition)
            await limparContexto(from);

            if (buttonId === 'acao_atualizar') {
                // Sprint 3 #2: LEDGER — INSERT nova linha, jamais UPDATE
                await atualizarPrecoLedger(loja.id, produto.nome, produto.preco, produto.unidade);
                await sendTextMessage(from, `✅ Preço de *${produto.nome}* atualizado para R$ ${produto.preco}!`);
            } else {
                // Sprint 4 #1/2/3: Soft Delete via INSERT com disponivel: false
                await retirarEstoqueLedger(loja.id, produto.nome, produto.unidade);
                await sendTextMessage(from, `✅ *${produto.nome}* retirado do estoque e oculto das buscas!`);
            }

            await delay(400);
            await enviarMenu(loja.nome, from);
            return;
        }

        // Sprint 12 #3: clique de ação diferente do esperado — cross-state contamination
        if (isInteractive && !buttonId.startsWith('menu_') && buttonId !== 'acao_atualizar' && buttonId !== 'acao_retirar') {
            await sendTextMessage(from, '⏳ Sessão expirada ou comando inválido. Vamos recomeçar!');
            await limparContexto(from);
            await delay(300);
            await enviarMenu(loja.nome, from);
            return;
        }

        // Texto no estado de escolha de botão → reenviar botões
        await sendTextMessage(from, 'Por favor, *clique em um dos botões* para continuar:');
        await delay(300);
        await sendInteractiveButtons(from,
            `O que deseja fazer com *${contexto.dadosProduto?.nome}*?`,
            [
                { id: 'acao_atualizar', title: 'Atualizar Valor' },
                { id: 'acao_retirar',  title: 'Retirar Estoque' },
            ]
        );
        return;
    }

    // ══════════════════════════════════════════════════════════
    // CENÁRIO: Fluxo de oferta
    // ══════════════════════════════════════════════════════════
    if (contexto.estado === EstadosFluxo.AGUARDANDO_DADOS_OFERTA) {
        if (isInteractive) return; // ignora cliques de botão neste estado

        if (!userMessageText.trim()) {
            await sendTextMessage(from, 'Por favor, envie os dados da oferta em texto.');
            return;
        }

        const prompt = `Extraia os dados da oferta. Responda APENAS JSON.\nRegras:\n1. Vírgula → ponto nos números\n2. Percentual: 0-100\n3. Data: YYYY-MM-DD\n\nRetorne: {"valor_minimo": numero, "percentual": numero, "validade": "YYYY-MM-DD", "produto_filtro": "string ou null"}\n\nMensagem: "${userMessageText}"\n\nJSON:`;

        try {
            const result = await ai.models.generateContent({
                model: GEMINI_MODEL,
                contents: prompt,
                config: { responseMimeType: 'application/json' },
            });
            logTokens('extrair_oferta', from, loja?.id ?? 'unknown', result.usageMetadata);
            const dados = parseSafe(OfertaExtraidaSchema, result.text || '{}', null as any);
            if (!dados) throw new Error('Dados da oferta inválidos ou incompletos');

            await criarOferta(loja.id, dados);
            await sendTextMessage(from, `✅ Oferta criada! *${dados.percentual}%* de desconto para compras acima de R$ ${dados.valor_minimo}. Válido até ${dados.validade}.`);
            await limparContexto(from);
            await delay(400);
            await enviarMenu(loja.nome, from);
        } catch (err) {
            logger.error({ err, from }, '[Oferta] Erro ao processar');
            await sendTextMessage(from, 'Não consegui criar a oferta. Envie: Valor mínimo (R$), Percentual (%) e Data de validade.');
        }
        return;
    }

    // Fallback: estado desconhecido → enviar menu e limpar
    logger.warn({ from, estado: contexto?.estado }, '[processMessage] Estado desconhecido, reiniciando para IDLE');
    await limparContexto(from);
    await enviarMenu(loja.nome, from);
}

// ============================================================
// MULTIMODAL (Sprint 11)
// ============================================================
async function processarMidia(msg: WhatsAppMessage, from: string, loja: any, contexto: ContextoSessao): Promise<void> {
    const MIME_PERMITIDOS = new Set(['image/jpeg', 'image/png', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/ogg; codecs=opus']);
    const TAMANHO_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

    const mediaInfo = (msg as any).image || (msg as any).audio || (msg as any).voice;
    if (!mediaInfo?.id) {
        await sendTextMessage(from, 'Não consegui processar esse tipo de arquivo. Por favor, *digite* os dados do produto.');
        return;
    }

    // Sprint 11 #1: validar mime-type
    const mimeType: string = mediaInfo.mime_type ?? '';
    if (!MIME_PERMITIDOS.has(mimeType)) {
        await sendTextMessage(from, `⚠️ Formato não suportado (${mimeType}). Envie fotos JPEG/PNG ou áudios OGG/MP4, ou *digite* os dados.`);
        return;
    }

    // Sprint 11 #1: validar tamanho
    const fileSize: number = mediaInfo.file_size ?? 0;
    if (fileSize > TAMANHO_MAX_BYTES) {
        await sendTextMessage(from, '⚠️ Arquivo muito pesado (máx 5MB). Por favor, envie uma foto menor ou *digite* os dados.');
        return;
    }

    try {
        // Sprint 11 #2: download para Buffer (RAM), nunca disco
        const buffer = await downloadMedia(mediaInfo.id);
        const base64 = buffer.toString('base64');

        const promptMultimodal = `Você é um extrator de dados de produtos de estoque.
Analise a imagem/áudio e retorne APENAS um JSON.

Regras de escape:
- Se imagem embaçada/ilegível ou áudio inaudível → {"legibilidade_baixa": true}
- Se há VÁRIOS produtos sem destaque claro → {"multiplos_produtos": true}
- Se for ruído de fundo (conversa, barulho) → {"ruido_detectado": true}
- Se conseguiu extrair → {"legibilidade_baixa": false, "multiplos_produtos": false, "ruido_detectado": false, "nome": "X", "preco": 10.50, "unidade": "Y"}

Nome em Title Case. Preço como número. Unidade máx 30 chars.

JSON:`;

        const safeMimeType = mimeType.split(';')[0]; // limpa 'codecs=opus' para evitar erro na API
        const imgPart: Part = { inlineData: { data: base64, mimeType: safeMimeType } };
        const result = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: [{ text: promptMultimodal }, imgPart],
            config: { responseMimeType: 'application/json' },
        });
        logTokens('multimodal_extracao', from, loja?.id ?? 'unknown', result.usageMetadata);
        const dados = parseSafe(MultimodalExtraidoSchema, result.text || '{}', { legibilidade_baixa: true } as any);

        // Sprint 11 #4: interceptação de flags de erro
        if (dados.legibilidade_baixa) {
            await sendTextMessage(from, '📷 A foto/áudio ficou difícil de ler. Pode mandar novamente com mais nitidez?');
            await renovarTTLContexto(from);
            return;
        }
        if (dados.multiplos_produtos) {
            await sendTextMessage(from, '🏪 Vejo vários produtos! Por favor, foque em *apenas uma etiqueta* por vez.');
            await renovarTTLContexto(from);
            return;
        }
        if (dados.ruido_detectado) {
            const pendencia = contexto.perguntaPendente || 'Por favor, envie o Nome, Preço e Unidade do produto.';
            await sendTextMessage(from, `Não sei sobre isso! 😅 Sou treinado apenas para organizar a sua loja.\n\n${pendencia}`);
            await renovarTTLContexto(from);
            return;
        }

        // Sprint 11 #5: engate com Sprint 2 (peneira de similares)
        const texto = `${dados.nome || ''} ${dados.preco || ''} ${dados.unidade || ''}`.trim();
        await processarDadosProduto(from, loja, texto, { ...contexto, dadosProduto: dados });

    } catch (err) {
        logger.error({ err, from }, '[Erro multimodal]');
        await sendTextMessage(from, '😕 Não consegui processar o arquivo. Por favor, *digite* o Nome, Preço e Unidade do produto.');
        await renovarTTLContexto(from);
    }
}

// ============================================================
// BANCO DE DADOS — LEDGER (Sprints 3 e 4)
// ============================================================

/**
 * Busca produtos similares:
 * 1ª peneira: pg_trgm (matemática, rápida, barata) — Sprint 2 #6, C2
 * 2ª peneira: Gemini (semântica) sobre o conjunto reduzido — Sprint 2 #7
 * Fallback: varredura total se pg_trgm não estiver ativo (graceful degradation)
 */
async function buscarProdutosSimilares(
    lojaId: string,
    termoBusca: string
): Promise<Array<{ id: string; produto_nome: string; preco: number; unidade: string }>> {

    let candidatos: any[] = [];

    // ── Etapa 1: Peneira matemática via pg_trgm RPC ──
    try {
        const { data: trgmData, error: trgmError } = await supabase
            .rpc('buscar_produtos_similares', {
                p_loja_id:   lojaId,
                p_termo:     termoBusca,
                p_threshold: 0.15,
            });

        if (!trgmError && trgmData && trgmData.length > 0) {
            candidatos = trgmData;
            logger.info({ lojaId, termoBusca, candidatos: candidatos.length }, '[Similares] pg_trgm retornou candidatos');
        } else if (trgmError) {
            // Função não existe ainda (migration não rodou) — degradar para full-scan
            logger.warn({ err: trgmError.message }, '[Similares] pg_trgm indisponível, usando full-scan');
        }
    } catch (err) {
        logger.warn({ err }, '[Similares] Erro no pg_trgm, degradando para full-scan');
    }

    // ── Fallback: full-scan se pg_trgm não retornou resultados ──
    if (candidatos.length === 0) {
        const { data, error } = await supabase
            .from('catalogo_historico')
            .select('id, produto_nome, preco, unidade')
            .eq('loja_id', lojaId)
            .eq('disponivel', true)
            .order('registrado_em', { ascending: false });

        if (error || !data || data.length === 0) return [];
        candidatos = data;
        logger.info({ lojaId, totalProdutos: candidatos.length }, '[Similares] Full-scan ativado');
    }

    if (candidatos.length === 0) return [];

    // ── Etapa 2: Lupa semântica Gemini sobre os candidatos ──
    const catalogList = candidatos
        .map((p: any, i: number) => `${i + 1}. ${p.produto_nome} (R$ ${p.preco} / ${p.unidade})`)
        .join('\n');

    try {
        const result = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: `O Lojista buscou o produto: "${termoBusca}".\nEncontre TODOS os que forem o mesmo produto no catálogo abaixo.\nATENÇÃO: Considere GRAVES erros ortográficos/fonéticos que usuários de WhatsApp cometem (ex: "Aros" querendo dizer "Arroz", "Massa" = "Macarrão", "Mussa" = "Muçarela"), além de sinônimos e variações de acento/marca.\nRetorne APENAS um array JSON de índices (começando em 1). Ex: [3, 1]. Se for um objeto de categoria completamente diferente e sem semelhança fonética, não inclua.\n\nCatálogo:\n${catalogList}\n\nJSON:`,
            config: { responseMimeType: 'application/json' },
        });
        logTokens('buscar_similares_gemini', lojaId, lojaId, result.usageMetadata);

        const indices = parseSafe(IndicesSimilaresSchema, result.text || '[]', []);
        return indices
            .filter((idx: number) => idx >= 1 && idx <= candidatos.length)
            .map((idx: number) => candidatos[idx - 1]);
    } catch (e) {
        logger.error({ e }, '[Similares] Erro no Gemini semântico');
        return [];
    }
}


/** Sprint 2 #9: INSERT com truncate de segurança */
async function ingeriCatalogo(lojaId: string, produto: DadosProduto): Promise<void> {
    const payload = {
        loja_id:        lojaId,
        produto_nome:   produto.nome.substring(0, 250),
        preco:          produto.preco,
        unidade:        (produto.unidade || 'un').substring(0, 30),
        disponivel:     true,
        fonte_ingestao: 'manual',
    };
    const { error } = await supabase.from('catalogo_historico').insert(payload);
    if (error) {
        logger.error({ error }, '[Ledger] Erro no INSERT de catálogo');
        throw new Error('Falha ao gravar produto no banco.');
    }
}

/**
 * Sprint 3 #2: LEDGER CORRETO — atualização de preço via INSERT de nova linha.
 * Nunca usa UPDATE para não destruir o histórico.
 */
async function atualizarPrecoLedger(lojaId: string, produtoNome: string, novoPreco: number, unidade: string): Promise<void> {
    const { error } = await supabase.from('catalogo_historico').insert({
        loja_id:        lojaId,
        produto_nome:   produtoNome.substring(0, 250),
        preco:          novoPreco,
        unidade:        (unidade || 'un').substring(0, 30),
        disponivel:     true,
        fonte_ingestao: 'manual',
    });
    if (error) {
        logger.error({ error }, '[Ledger] Erro ao atualizar preço');
        throw new Error('Falha ao atualizar preço.');
    }
}

/**
 * Sprint 4 #1/2/3/4: Soft Delete via INSERT com disponivel: false.
 * Copia o último preço conhecido (constraint NOT NULL).
 * Verifica redundância antes de inserir.
 */
async function retirarEstoqueLedger(lojaId: string, produtoNome: string, unidadeConhecida: string): Promise<void> {
    // Busca o registro mais recente para verificar status e copiar preço
    const { data: ultimo } = await supabase
        .from('catalogo_historico')
        .select('preco, unidade, disponivel')
        .eq('loja_id', lojaId)
        .ilike('produto_nome', `%${produtoNome}%`)
        .order('registrado_em', { ascending: false })
        .limit(1)
        .single();

    // Sprint 4 #4: proteção contra redundância
    if (ultimo && ultimo.disponivel === false) {
        logger.info({ lojaId, produtoNome }, '[Ledger] Produto já fora de estoque — sem ação');
        return;
    }

    const { error } = await supabase.from('catalogo_historico').insert({
        loja_id:        lojaId,
        produto_nome:   produtoNome.substring(0, 250),
        preco:          ultimo?.preco ?? 0,   // Sprint 4 #3: cópia obrigatória do preço (NOT NULL)
        unidade:        (ultimo?.unidade || unidadeConhecida || 'un').substring(0, 30),
        disponivel:     false,
        fonte_ingestao: 'manual',
    });
    if (error) {
        logger.error({ error }, '[Ledger] Erro no Soft Delete');
        throw new Error('Falha ao retirar produto do estoque.');
    }
}

async function obterEstatisticas(lojaId: string) {
    const { data: loja } = await supabase.from('lojas').select('saldo_cliques, ativa').eq('id', lojaId).single();
    const trintaDiasAtras = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { count } = await supabase.from('cliques_consumidos')
        .select('*', { count: 'exact', head: true })
        .eq('loja_id', lojaId)
        .eq('debitado', true)
        .gte('consumido_em', trintaDiasAtras);
    return { saldo: loja?.saldo_cliques ?? 0, status: loja?.ativa ? 'Ativa' : 'Pausada', cliques_30d: count || 0 };
}

// Sprint 1 #12/13: tratamento de erros 403 e 429 já está em whatsapp.ts
async function criarOferta(lojaId: string, dados: any): Promise<void> {
    const { error } = await supabase.from('ofertas_desconto').insert({
        loja_id:        lojaId,
        valor_minimo:   dados.valor_minimo,
        percentual:     dados.percentual,
        validade:       dados.validade,
        produto_filtro: dados.produto_filtro || null,
    });
    if (error) throw error;
}

async function buscarOfertasAtivas(lojaId: string) {
    const hoje = new Date().toISOString().split('T')[0];
    const { data, error } = await supabase
        .from('ofertas_desconto')
        .select('id, valor_minimo, percentual, validade, produto_filtro')
        .eq('loja_id', lojaId)
        .gte('validade', hoje)
        .order('validade', { ascending: true });
    if (error) throw error;
    return data || [];
}
