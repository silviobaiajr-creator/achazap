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
    cache,
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
    MultiProdutosTextoSchema,
    parseSafe,
} from './schemas.js';

import { ai, GEMINI_MODEL } from '../lib/gemini.js';

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
    itensPendenteConfirmacao?: Array<DadosProduto>; // produtos extraídos de foto/áudio aguardando OK do lojista
    alteracoesPlanejadas?: Array<AlteracaoPlanejada>; // resumo comparativo antes de confirmar
}

type TipoAlteracao = 'novo_cadastro' | 'preco_atualizado' | 'sem_alteracao' | 'ambiguo';

interface AlteracaoPlanejada {
    nome: string;
    precoFoto: number;
    unidade: string;
    acao: TipoAlteracao;
    produtoExistente?: { id: string; produto_nome: string; preco: number; unidade: string };
    similares?: Array<{ id: string; produto_nome: string; preco: number; unidade: string }>;
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
    const cacheKey = `loja:${whatsapp}`;

    try {
        const cached = cache.get(cacheKey);
        if (cached) return cached;
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
        try { cache.set(cacheKey, data, 300 * 1000); } catch { /* ignora */ }
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
    // ATENÇÃO: pular para mensagens interativas dos nossos próprios fluxos de confirmação
    // (ex: botão "Cancelar" não deve disparar fuga global)
    const isConfirmacaoInterna = buttonId.startsWith('confirmar_') || buttonId.startsWith('btn_sugestao');
    if (userText && PALAVRAS_FUGA.test(userText.trim()) && !isConfirmacaoInterna) {
        await executarFuga(from, loja);
        return true;
    }

    // Nível 3: NLP para frases coloquiais (apenas se há contexto ativo E não é botão interno)
    if (temContextoAtivo && userText && userText.length > 3 && !isConfirmacaoInterna) {
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
        // Substitui a reaction pelo próprio sistema nativo quando aplicável ou ignora
        // await redis.call('sendReaction', from, '🔍').catch(() => {});  // best-effort
    } catch { /* ignora se API não suportar */ }

    const promptMulti = `Você é um extrator de produtos de estoque. Analise a mensagem e extraia TODOS os produtos encontrados.

Regras:
1. Extraia TODOS os produtos da mensagem (ex: "Coca 5,00, guaraná 4,50, pão 3,00" = 3 produtos)
2. Preços com vírgula → converter para ponto
3. Nome em Title Case, Unidade máx 30 chars (padrão "un")
4. Se a mensagem contém APENAS um produto, continue funcionando como antes

Retorne formato:
- Se múltiplos: {"ruido_detectado": false, "itens": [{"nome": "Coca Cola", "preco": 5.00, "unidade": "un"}, {outro}]}
- Se ruído: {"ruido_detectado": true}
- Se apenas um (compatibilidade): {"ruido_detectado": false, "nome": "...", "preco": ..., "unidade": "..."}

Mensagem: "${userMessageText}"

JSON:`;

    try {
        const result = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: promptMulti,
            config: { responseMimeType: 'application/json' },
        });

        const rawText = result.text || '{}';
        logTokens('extrair_produto', from, loja?.id ?? 'unknown', result.usageMetadata);
        logger.debug({ from, rawText }, '[Gemini] extração produto');

        // Tenta extrair múltiplos produtos primeiro
        const dadosMulti = parseSafe(MultiProdutosTextoSchema, rawText, {
            ruido_detectado: false,
            itens: []
        });

        // Se detectou múltiplos produtos, entra no fluxo de lote
        if (!dadosMulti.ruido_detectado && dadosMulti.itens && dadosMulti.itens.length > 1) {
            logger.info({ from, count: dadosMulti.itens.length }, '[processarDadosProduto] Múltiplos produtos detectados');
            const itensFormatados = dadosMulti.itens.map((i: any) => ({
                nome: i.nome,
                preco: i.preco,
                unidade: i.unidade || 'un'
            }));
            await processarLoteProdutos(from, loja, itensFormatados, contexto);
            return;
        }

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
    // PROCESSAMENTO EM LOTE (Texto ou Foto com múltiplos produtos)
    // ============================================================
    async function processarLoteProdutos(
        from: string,
        loja: any,
        itensRaw: Array<{nome: string; preco: number; unidade: string}>,
        contexto: ContextoSessao
    ): Promise<void> {
        const itensValidos: DadosProduto[] = itensRaw
            .filter((i: any) => i.nome && i.preco > 0)
            .map((i: any) => ({
                nome: String(i.nome).substring(0, 250),
                preco: i.preco as number,
                unidade: String(i.unidade || 'un').substring(0, 30),
            }));

        if (itensValidos.length === 0) {
            await sendTextMessage(from, 'Nenhum produto válido encontrado.');
            return;
        }

        await sendTextMessage(from, `⏳ Verificando *${itensValidos.length}* produto(s) no estoque...`);

        const alteracoes: AlteracaoPlanejada[] = [];
        const linhas: string[] = [];

        for (let i = 0; i < itensValidos.length; i++) {
            const item = itensValidos[i];
            if (!item.nome || item.preco <= 0) continue;

            const similares = await buscarProdutosSimilares(loja.id, item.nome);
            const alteracao: AlteracaoPlanejada = {
                nome: item.nome,
                precoFoto: item.preco,
                unidade: item.unidade,
                acao: 'sem_alteracao',
            };

            if (similares.length > 0) {
                if (similares.length > 1) {
                    alteracao.similares = similares;
                    alteracao.acao = 'ambiguo';
                    linhas.push(`${i + 1}. ${item.nome}\n   ⚠️ ${similares.length} opções no estoque (Foto: R$ ${item.preco.toFixed(2).replace('.', ',')}) → ⚠️ Ambíguo`);
                } else {
                    const maisProximo = similares[0];
                    alteracao.produtoExistente = {
                        id: maisProximo.id,
                        produto_nome: maisProximo.produto_nome,
                        preco: maisProximo.preco,
                        unidade: maisProximo.unidade,
                    };

                    if (maisProximo.preco === item.preco) {
                        alteracao.acao = 'sem_alteracao';
                        linhas.push(`${i + 1}. ${item.nome}\n   Estoque: R$ ${maisProximo.preco.toFixed(2).replace('.', ',')} | Foto: R$ ${item.preco.toFixed(2).replace('.', ',')} → ⏭️ Sem alteração`);
                    } else {
                        alteracao.acao = 'preco_atualizado';
                        linhas.push(`${i + 1}. ${item.nome}\n   Estoque: R$ ${maisProximo.preco.toFixed(2).replace('.', ',')} | Foto: R$ ${item.preco.toFixed(2).replace('.', ',')} → 🔄 Atualizar`);
                    }
                }
            } else {
                alteracao.acao = 'novo_cadastro';
                linhas.push(`${i + 1}. ${item.nome}\n   Estoque: (não existe) | Foto: R$ ${item.preco.toFixed(2).replace('.', ',')} → ✅ Novo`);
            }

            alteracoes.push(alteracao);
        }

        if (alteracoes.length === 0) {
            await sendTextMessage(from, 'Nenhum produto válido encontrado.');
            return;
        }

        const linhasAgrupadas = linhas.slice(0, 30).join('\n');
        const sufixo = linhas.length > 30 ? `\n\n...e mais ${linhas.length - 30} item(s).` : '';
        const totalNovos = alteracoes.filter(a => a.acao === 'novo_cadastro').length;
        const totalAtualizar = alteracoes.filter(a => a.acao === 'preco_atualizado').length;
        const totalIgual = alteracoes.filter(a => a.acao === 'sem_alteracao').length;
        const totalAmbiguo = alteracoes.filter(a => a.acao === 'ambiguo').length;

        let resumo = `📋 *Resumo das alterações:*\n\n`;
        if (totalNovos > 0) resumo += `✅ Novo(s): ${totalNovos}\n`;
        if (totalAtualizar > 0) resumo += `🔄 Atualizar: ${totalAtualizar}\n`;
        if (totalIgual > 0) resumo += `⏭️ Sem alteração: ${totalIgual}\n`;
        if (totalAmbiguo > 0) resumo += `⚠️ Ambíguo(s): ${totalAmbiguo}\n`;
        resumo += `\n${linhasAgrupadas}${sufixo}`;

        await salvarContexto(from, {
            ...contexto,
            estado: EstadosFluxo.AGUARDANDO_CONFIRMACAO_ALTERACOES,
            itensPendenteConfirmacao: itensValidos,
            alteracoesPlanejadas: alteracoes,
        });

        await sendTextMessage(from, resumo);
        await delay(300);
        await sendInteractiveButtons(from, `⚡ Confirma as alterações acima?`, [
            { id: 'confirmar_alteracoes_sim', title: '✅ Confirmar Todos' },
            { id: 'editar_item_lista', title: '✏️ Editar um Item' },
            { id: 'confirmar_alteracoes_nao', title: '❌ Cancelar Tudo' },
        ]);
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
        const { inserido } = await ingeriCatalogo(loja.id, produto);
        const msg = inserido
            ? `✅ Produto *${produto.nome}* (${produto.unidade}) a *R$ ${produto.preco}* cadastrado com sucesso!`
            : `⚠️ Produto *${produto.nome}* com o mesmo preço já existe no seu catálogo. Nenhuma alteração foi feita.`;
        await sendTextMessage(from, msg);
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
    // INTERCEPTADOR DE CSV (Sprint 14 - Scale_Up)
    // ══════════════════════════════════════════════════════════
    if (msg.type === 'document') {
        const doc = (msg as any).document;
        if (doc && (doc.mime_type === 'text/csv' || doc?.filename?.endsWith('.csv'))) {
            await sendTextMessage(from, '⏳ Identifiquei um arquivo CSV! Entrando no modo de extração em lote. Processando...');
            const { processarCSV } = await import('../processor/csvProcessor.js');
            await processarCSV(msg, from, loja, contexto);
            return;
        }
    }

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
// CONFIRMAÇÃO DE ALTERAÇÕES PLANEJADAS (com edição individual)
    // ════════════════════════════════════════════════════════════════
    if (contexto.estado === EstadosFluxo.AGUARDANDO_CONFIRMACAO_ALTERACOES) {
        const alteracoes = contexto.alteracoesPlanejadas ?? [];
        
        const confirmou = isInteractive && buttonId === 'confirmar_alteracoes_sim';
        const cancelou  = isInteractive && buttonId === 'confirmar_alteracoes_nao';
        const editar   = isInteractive && buttonId === 'editar_item_lista';
        
        if (confirmou) {
            // Validação: verificando se há itens ambíguos não resolvidos
            const ambiguos = alteracoes.filter(a => a.acao === 'ambiguo');
            if (ambiguos.length > 0) {
                await sendTextMessage(from, `⚠️ Atenção! Você tem *${ambiguos.length}* produto(s) ambiguo(s) na lista. Use o botão *✏️ Editar um Item* para escolher qual produto do estoque corresponde à foto.`);
                return;
            }
            
            if (alteracoes.length === 0) {
                await sendTextMessage(from, 'Nada a alterar. Tente novamente.');
                await limparContexto(from);
                await enviarMenu(loja.nome, from);
                return;
            }
            
            let inseridos = 0;
            let atualizados = 0;
            let duplicatas = 0;
            
            for (const alt of alteracoes) {
                if (alt.acao === 'novo_cadastro') {
                    await ingeriCatalogo(loja.id, { nome: alt.nome, preco: alt.precoFoto, unidade: alt.unidade }, 'foto');
                    inseridos++;
                } else if (alt.acao === 'preco_atualizado' && alt.produtoExistente) {
                    await atualizarPrecoLedger(loja.id, alt.produtoExistente.produto_nome, alt.precoFoto, alt.unidade || alt.produtoExistente.unidade);
                    atualizados++;
                } else {
                    duplicatas++;
                }
            }
            
            const partes: string[] = [];
            if (inseridos > 0)   partes.push(`✅ *${inseridos}* novo(s) cadastrado(s)`);
            if (atualizados > 0) partes.push(`🔄 *${atualizados}* preço(s) atualizado(s)`);
            if (duplicatas > 0)  partes.push(`⏭️ *${duplicatas}* sem alteração (mesmo preço)`);
            await sendTextMessage(from, partes.join('\n'));
            await limparContexto(from);
            await delay(400);
            await enviarMenu(loja.nome, from);
            return;
        }
        
        if (editar) {
            await salvarContexto(from, {
                ...contexto,
                estado: EstadosFluxo.AGUARDANDO_SELECAO_EDICAO,
            });
            await sendTextMessage(from, `Digite o *NÚMERO* do item que deseja editar:\n(Exemplo: digite "2" para editar o segundo item)`);
            return;
        }
        
        if (cancelou) {
            await sendTextMessage(from, '❌ Alterações canceladas. Nada foi salvo.');
            await limparContexto(from);
            await delay(400);
            await enviarMenu(loja.nome, from);
            return;
        }
        
        await sendInteractiveButtons(from, `⚡ Confirma as alterações acima?`, [
            { id: 'confirmar_alteracoes_sim', title: '✅ Confirmar Todos' },
            { id: 'editar_item_lista', title: '✏️ Editar um Item' },
            { id: 'confirmar_alteracoes_nao', title: '❌ Cancelar Tudo' },
        ]);
        return;
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // FLUXO: Lojista escolhe número para editar
    // ════════════════════════════════════════════════════════════════
    if (contexto.estado === EstadosFluxo.AGUARDANDO_SELECAO_EDICAO) {
        const lista = contexto.alteracoesPlanejadas ?? [];
        const numeroDigitado = parseInt(userMessageText.trim(), 10);
        
        if (isNaN(numeroDigitado) || numeroDigitado < 1 || numeroDigitado > lista.length) {
            await sendTextMessage(from, `⚠️ Número inválido. Digite um número entre *1* e *${lista.length}*.`);
            return;
        }
        
        const indiceReal = numeroDigitado - 1;
        const itemEscolhido = lista[indiceReal];
        
        // Se o item tem múltiplas opções (ambíguo), mostra a lista para desempate
        if (itemEscolhido.acao === 'ambiguo' && itemEscolhido.similares && itemEscolhido.similares.length > 1) {
            let msgOpcoes = `⚠️ Encontrei ${itemEscolhido.similares.length} opções no seu estoque. Qual é o da foto?\n\n`;
            itemEscolhido.similares.forEach((s: any, idx: number) => {
                msgOpcoes += `${idx + 1} - ${s.produto_nome} (R$ ${s.preco.toFixed(2).replace('.', ',')} / ${s.unidade})\n`;
            });
            msgOpcoes += `\n0 - Nenhum (cadastrar como novo)`;
            
            await salvarContexto(from, {
                ...contexto,
                estado: EstadosFluxo.AGUARDANDO_NOVO_PRECO_EDICAO,
                acao: indiceReal.toString() + '_desempate',
                perguntaPendente: msgOpcoes,
            });
            
            await sendTextMessage(from, msgOpcoes);
            return;
        }
        
        await salvarContexto(from, {
            ...contexto,
            estado: EstadosFluxo.AGUARDANDO_NOVO_PRECO_EDICAO,
            acao: indiceReal.toString(),
        });
        
        await sendTextMessage(from, 
            `Você escolheu: *${itemEscolhido.nome}*\nPreço na lista: R$ ${itemEscolhido.precoFoto.toFixed(2).replace('.', ',')}\n\n👉 Digite o *NOVO PREÇO* ou digite *0* para excluir este item:`
        );
        return;
    }
    
    // ═══════════════════════════════════════════════════════════════
    // FLUXO: Lojista digita novo preço ou 0 para excluir
    // ════════════════════════════════════════════════════════════════
    if (contexto.estado === EstadosFluxo.AGUARDANDO_NOVO_PRECO_EDICAO) {
        const lista = contexto.alteracoesPlanejadas ?? [];
        
        // Verifica se está em modo de desempate (escolher qual similar usar)
        if (contexto.acao?.includes('_desempate')) {
            const [indiceStr] = contexto.acao.split('_');
            const indiceReal = parseInt(indiceStr, 10);
            const item = lista[indiceReal];
            const opcaoNum = parseInt(userMessageText.trim(), 10);
            
            if (isNaN(opcaoNum) || opcaoNum < 0 || opcaoNum > (item.similares?.length ?? 0)) {
                await sendTextMessage(from, `⚠️ Número inválido. Digite entre *0* e *${item.similares?.length}*.`);
                return;
            }
            
            if (opcaoNum === 0) {
                // Usuário escolheu "Nenhum" - cadastrar como novo
                item.acao = 'novo_cadastro';
                item.produtoExistente = undefined;
                item.similares = undefined;
            } else {
                // Usuário escolheu um dos similares
                const similarEscolhido = item.similares![opcaoNum - 1];
                item.produtoExistente = {
                    id: similarEscolhido.id,
                    produto_nome: similarEscolhido.produto_nome,
                    preco: similarEscolhido.preco,
                    unidade: similarEscolhido.unidade,
                };
                item.similares = undefined; // limpa a lista
                
                if (similarEscolhido.preco === item.precoFoto) {
                    item.acao = 'sem_alteracao';
                } else {
                    item.acao = 'preco_atualizado';
                }
            }
            
            await salvarContexto(from, {
                ...contexto,
                estado: EstadosFluxo.AGUARDANDO_CONFIRMACAO_ALTERACOES,
                alteracoesPlanejadas: lista,
                acao: undefined,
            });
            
            // Reconstruir resumo com detalhes
            let novoResumo = `📋 *Resumo atualizado:*\n\n`;
            let novos = 0, atualizados = 0, iguais = 0, ambiguos = 0;
            lista.forEach((item: any, i: number) => {
                const simbolo = item.acao === 'novo_cadastro' ? '✅' : item.acao === 'preco_atualizado' ? '🔄' : item.acao === 'ambiguo' ? '⚠️' : '⏭️';
                
                let linha = `${i + 1}. ${item.nome} → R$ ${item.precoFoto.toFixed(2).replace('.', ',')} ${simbolo}`;
                
                if (item.acao === 'ambiguo' && item.similares) {
                    linha += `\n   ⚠️ ${item.similares.length} opções no estoque`;
                } else if (item.acao === 'preco_atualizado' && item.produtoExistente) {
                    linha += `\n   Estoque: ${item.produtoExistente.produto_nome} (R$ ${item.produtoExistente.preco.toFixed(2).replace('.', ',')})`;
                } else if (item.acao === 'sem_alteracao' && item.produtoExistente) {
                    linha += `\n   Estoque: ${item.produtoExistente.produto_nome} (R$ ${item.produtoExistente.preco.toFixed(2).replace('.', ',')})`;
                } else if (item.acao === 'novo_cadastro') {
                    linha += `\n   Estoque: (não existe)`;
                }
                
                novoResumo += linha + '\n';
                if (item.acao === 'novo_cadastro') novos++;
                else if (item.acao === 'preco_atualizado') atualizados++;
                else if (item.acao === 'sem_alteracao') iguais++;
                else ambiguos++;
            });
            
            // Contador
            let contadores = '';
            if (novos > 0) contadores += `✅ Novo(s): ${novos} `;
            if (atualizados > 0) contadores += `🔄 Atualizar: ${atualizados} `;
            if (iguais > 0) contadores += `⏭️ Iguais: ${iguais} `;
            if (ambiguos > 0) contadores += `⚠️ Ambíguos: ${ambiguos}`;
            
            await sendTextMessage(from, `✅ Escolha registrada!\n\n${contadores}\n\n${novoResumo}`);
            await delay(300);
            await sendInteractiveButtons(from, `O que deseja fazer agora?`, [
                { id: 'confirmar_alteracoes_sim', title: '✅ Confirmar Todos' },
                { id: 'editar_item_lista', title: '✏️ Editar outro' },
                { id: 'confirmar_alteracoes_nao', title: '❌ Cancelar Tudo' },
            ]);
            return;
        }
        
        // Modo normal: editar preço ou excluir
        const indiceReal = parseInt(contexto.acao ?? '0', 10);
        
        const precoLimpo = userMessageText.replace(',', '.').replace(/[^\d.]/g, '');
        const novoPreco = parseFloat(precoLimpo);
        
        if (isNaN(novoPreco) || novoPreco < 0) {
            await sendTextMessage(from, '⚠️ Valor inválido. Digite um número como "9,50", ou "0" para excluir o item.');
            return;
        }
        
        let mensagemFeedback = '';
        
        if (novoPreco === 0) {
            lista.splice(indiceReal, 1);
            
            if (lista.length === 0) {
                await sendTextMessage(from, '🗑️ Você removeu todos os itens da lista. A operação foi cancelada.');
                await limparContexto(from);
                await delay(400);
                await enviarMenu(loja.nome, from);
                return;
            }
            mensagemFeedback = '🗑️ Item removido com sucesso!';
        } else {
            lista[indiceReal].precoFoto = novoPreco;
            
            if (lista[indiceReal].produtoExistente && lista[indiceReal].produtoExistente.preco === novoPreco) {
                lista[indiceReal].acao = 'sem_alteracao';
            } else if (lista[indiceReal].produtoExistente) {
                lista[indiceReal].acao = 'preco_atualizado';
            }
            mensagemFeedback = '✅ Preço corrigido!';
        }
        
        await salvarContexto(from, {
            ...contexto,
            estado: EstadosFluxo.AGUARDANDO_CONFIRMACAO_ALTERACOES,
            alteracoesPlanejadas: lista,
            acao: undefined,
        });
        
        let novoResumo = `📋 *Resumo atualizado:*\n\n`;
        lista.forEach((item: any, i: number) => {
            const simbolo = item.acao === 'novo_cadastro' ? '✅' : item.acao === 'preco_atualizado' ? '🔄' : item.acao === 'ambiguo' ? '⚠️' : '⏭️';
            
            let linha = `${i + 1}. ${item.nome} → R$ ${item.precoFoto.toFixed(2).replace('.', ',')} ${simbolo}`;
            
            if (item.acao === 'ambiguo' && item.similares) {
                linha += `\n   ⚠️ ${item.similares.length} opções no estoque`;
            } else if (item.acao === 'preco_atualizado' && item.produtoExistente) {
                linha += `\n   Estoque: ${item.produtoExistente.produto_nome} (R$ ${item.produtoExistente.preco.toFixed(2).replace('.', ',')})`;
            } else if (item.acao === 'sem_alteracao' && item.produtoExistente) {
                linha += `\n   Estoque: ${item.produtoExistente.produto_nome} (R$ ${item.produtoExistente.preco.toFixed(2).replace('.', ',')})`;
            } else if (item.acao === 'novo_cadastro') {
                linha += `\n   Estoque: (não existe)`;
            }
            
            novoResumo += linha + '\n';
        });
        
        await sendTextMessage(from, `${mensagemFeedback}\n\n${novoResumo}`);
        await delay(300);
        await sendInteractiveButtons(from, `O que deseja fazer agora?`, [
            { id: 'confirmar_alteracoes_sim', title: '✅ Confirmar Todos' },
            { id: 'editar_item_lista', title: '✏️ Editar outro' },
            { id: 'confirmar_alteracoes_nao', title: '❌ Cancelar Tudo' },
        ]);
        return;
    }

    // CONFIRMAÇÃO INICIAL DE PRODUTOS EXTRAÍDOS DE FOTO/ÁUDIO
    // ════════════════════════════════════════════════════════════════
    if (contexto.estado === EstadosFluxo.AGUARDANDO_CONFIRMACAO_MULTIMODAL) {
        const itens = contexto.itensPendenteConfirmacao ?? [];

        const confirmou = isInteractive && buttonId === 'confirmar_multimodal_sim';
        const cancelou  = isInteractive && buttonId === 'confirmar_multimodal_nao';

        if (confirmou) {
            if (itens.length === 0) {
                await sendTextMessage(from, 'Não encontrei produtos para salvar. Tente novamente.');
                await limparContexto(from);
                await enviarMenu(loja.nome, from);
                return;
            }
            
            await sendTextMessage(from, `⏳ Verificando *${itens.length}* produto(s) no estoque...`);
            
            const alteracoes: AlteracaoPlanejada[] = [];
            const linhas: string[] = [];
            
            for (let i = 0; i < itens.length; i++) {
                const item = itens[i];
                if (!item.nome || item.preco <= 0) continue;
                
                const similares = await buscarProdutosSimilares(loja.id, item.nome);
                const alteracao: AlteracaoPlanejada = {
                    nome: item.nome,
                    precoFoto: item.preco,
                    unidade: item.unidade,
                    acao: 'sem_alteracao',
                };
                
                if (similares.length > 0) {
                    // Verifica se há ambiguidade (múltiplos resultados)
                    if (similares.length > 1) {
                        alteracao.similares = similares;
                        alteracao.acao = 'ambiguo';
                        linhas.push(`${i + 1}. ${item.nome}\n   ⚠️ ${similares.length} opções no estoque (Foto: R$ ${item.preco.toFixed(2).replace('.', ',')}) → ⚠️ Ambíguo`);
                    } else {
                        const maisProximo = similares[0];
                        alteracao.produtoExistente = {
                            id: maisProximo.id,
                            produto_nome: maisProximo.produto_nome,
                            preco: maisProximo.preco,
                            unidade: maisProximo.unidade,
                        };
                        
                        if (maisProximo.preco === item.preco) {
                            alteracao.acao = 'sem_alteracao';
                            linhas.push(`${i + 1}. ${item.nome}\n   Estoque: R$ ${maisProximo.preco.toFixed(2).replace('.', ',')} | Foto: R$ ${item.preco.toFixed(2).replace('.', ',')} → ⏭️ Sem alteração`);
                        } else {
                            alteracao.acao = 'preco_atualizado';
                            linhas.push(`${i + 1}. ${item.nome}\n   Estoque: R$ ${maisProximo.preco.toFixed(2).replace('.', ',')} | Foto: R$ ${item.preco.toFixed(2).replace('.', ',')} → 🔄 Atualizar`);
                        }
                    }
                } else {
                    alteracao.acao = 'novo_cadastro';
                    linhas.push(`${i + 1}. ${item.nome}\n   Estoque: (não existe) | Foto: R$ ${item.preco.toFixed(2).replace('.', ',')} → ✅ Novo cadastro`);
                }
                
                alteracoes.push(alteracao);
            }
            
            if (alteracoes.length === 0) {
                await sendTextMessage(from, 'Nenhum produto válido encontrado.');
                await limparContexto(from);
                await enviarMenu(loja.nome, from);
                return;
            }
            
            const linhasAgrupadas = linhas.slice(0, 30).join('\n');
            const sufixo = linhas.length > 30 ? `\n\n...e mais ${linhas.length - 30} item(s).` : '';
            const totalNovos = alteracoes.filter(a => a.acao === 'novo_cadastro').length;
            const totalAtualizar = alteracoes.filter(a => a.acao === 'preco_atualizado').length;
            const totalIgual = alteracoes.filter(a => a.acao === 'sem_alteracao').length;
            const totalAmbiguo = alteracoes.filter(a => a.acao === 'ambiguo').length;
            
            let resumo = `📋 *Resumo das alterações:*\n\n`;
            if (totalNovos > 0) resumo += `✅ Novo(s): ${totalNovos}\n`;
            if (totalAtualizar > 0) resumo += `🔄 Atualizar: ${totalAtualizar}\n`;
            if (totalIgual > 0) resumo += `⏭️ Sem alteração: ${totalIgual}\n`;
            if (totalAmbiguo > 0) resumo += `⚠️ Ambíguo(s): ${totalAmbiguo}\n`;
            resumo += `\n${linhasAgrupadas}${sufixo}`;
            
            await salvarContexto(from, {
                ...contexto,
                estado: EstadosFluxo.AGUARDANDO_CONFIRMACAO_ALTERACOES,
                alteracoesPlanejadas: alteracoes,
            });
            
            await sendTextMessage(from, resumo);
            await delay(300);
            await sendInteractiveButtons(from, `⚡ Confirma as alterações acima?`, [
                { id: 'confirmar_alteracoes_sim', title: '✅ Confirmar Todos' },
                { id: 'editar_item_lista', title: '✏️ Editar um Item' },
                { id: 'confirmar_alteracoes_nao', title: '❌ Cancelar Tudo' },
            ]);
            return;
        }

        if (cancelou) {
            await sendTextMessage(from, '❌ Cadastro cancelado. Nada foi salvo.');
            await limparContexto(from);
            await delay(400);
            await enviarMenu(loja.nome, from);
            return;
        }

        await sendInteractiveButtons(from, `Confirme: deseja salvar *${itens.length}* produto(s) no catálogo?`, [
            { id: 'confirmar_multimodal_sim', title: '✅ Salvar todos' },
            { id: 'confirmar_multimodal_nao', title: '❌ Cancelar' },
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
                const { inserido } = await ingeriCatalogo(loja.id, produto);
                const msgSimilar = inserido
                    ? `✅ Produto *${produto.nome}* (${produto.unidade}) a *R$ ${produto.preco}* cadastrado com sucesso!`
                    : `⚠️ Produto *${produto.nome}* com o mesmo preço já existe no catálogo. Nenhuma alteração foi feita.`;
                await sendTextMessage(from, msgSimilar);
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

        const promptMultimodal = `Você é um extrator de dados de catálogo de supermercado/restaurante.
Analise a imagem/áudio e retorne APENAS um JSON.
Sua tarefa é extrair TODOS os produtos legíveis e inseri-los no array "itens".

Regras de escape:
- Se imagem estiver 100% embaçada/ilegível ou áudio for inaudível/ruído → {"legibilidade_baixa": true, "ruido_detectado": true, "itens": []}
- Se os dados estiverem visíveis/audíveis, extraia TODOS.

Nome em Title Case. Preço como número. Unidade máx 30 chars.
Se a unidade não estiver clara, use "un".
Formato de saída esperado:
{"legibilidade_baixa": false, "ruido_detectado": false, "itens": [{"nome": "Coca Cola 2L", "preco": 10.50, "unidade": "un"}, {"nome": "Guaraná Antártica", "preco": 8.00, "unidade": "un"}]}

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
        if (dados.ruido_detectado || !('itens' in dados) || !dados.itens || dados.itens.length === 0) {
            const pendencia = contexto.perguntaPendente || 'Por favor, envie o Nome, Preço e Unidade do(s) produto(s).';
            await sendTextMessage(from, `Não encontrei produtos válidos na mídia. 😅\n\n${pendencia}`);
            await renovarTTLContexto(from);
            return;
        }

        // Monta preview dos produtos extraídos para confirmação do lojista
        const itensValidos: DadosProduto[] = dados.itens
            .filter((i: any) => i.nome && i.preco > 0)
            .map((i: any) => ({
                nome: String(i.nome).substring(0, 250),
                preco: i.preco as number,
                unidade: String(i.unidade || 'un').substring(0, 30),
            }));

        if (itensValidos.length === 0) {
            await sendTextMessage(from, 'Nenhum produto válido foi encontrado na mídia. 😅');
            await renovarTTLContexto(from);
            return;
        }

        await sendTextMessage(from, `⏳ Verificando *${itensValidos.length}* produto(s) no estoque...`);

        const alteracoes: AlteracaoPlanejada[] = [];
        const linhas: string[] = [];

        for (let i = 0; i < itensValidos.length; i++) {
            const item = itensValidos[i];
            if (!item.nome || item.preco <= 0) continue;

            const similares = await buscarProdutosSimilares(loja.id, item.nome);
            const alteracao: AlteracaoPlanejada = {
                nome: item.nome,
                precoFoto: item.preco,
                unidade: item.unidade,
                acao: 'sem_alteracao',
            };

            if (similares.length > 0) {
                // Verifica se há ambiguidade (múltiplos resultados)
                if (similares.length > 1) {
                    alteracao.similares = similares;
                    alteracao.acao = 'ambiguo';
                    linhas.push(`${i + 1}. ${item.nome}\n   ⚠️ ${similares.length} opções no estoque (Foto: R$ ${item.preco.toFixed(2).replace('.', ',')}) → ⚠️ Ambíguo`);
                } else {
                    const maisProximo = similares[0];
                    alteracao.produtoExistente = {
                        id: maisProximo.id,
                        produto_nome: maisProximo.produto_nome,
                        preco: maisProximo.preco,
                        unidade: maisProximo.unidade,
                    };

                    if (maisProximo.preco === item.preco) {
                        alteracao.acao = 'sem_alteracao';
                        linhas.push(`${i + 1}. ${item.nome}\n   Estoque: R$ ${maisProximo.preco.toFixed(2).replace('.', ',')} | Foto: R$ ${item.preco.toFixed(2).replace('.', ',')} → ⏭️ Sem alteração`);
                    } else {
                        alteracao.acao = 'preco_atualizado';
                        linhas.push(`${i + 1}. ${item.nome}\n   Estoque: R$ ${maisProximo.preco.toFixed(2).replace('.', ',')} | Foto: R$ ${item.preco.toFixed(2).replace('.', ',')} → 🔄 Atualizar`);
                    }
                }
            } else {
                alteracao.acao = 'novo_cadastro';
                linhas.push(`${i + 1}. ${item.nome}\n   Estoque: (não existe) | Foto: R$ ${item.preco.toFixed(2).replace('.', ',')} → ✅ Novo`);
            }

            alteracoes.push(alteracao);
        }

        if (alteracoes.length === 0) {
            await sendTextMessage(from, 'Nenhum produto válido encontrado.');
            await limparContexto(from);
            await enviarMenu(loja.nome, from);
            return;
        }

        const linhasAgrupadas = linhas.slice(0, 30).join('\n');
        const sufixo = linhas.length > 30 ? `\n\n...e mais ${linhas.length - 30} item(s).` : '';
        const totalNovos = alteracoes.filter(a => a.acao === 'novo_cadastro').length;
        const totalAtualizar = alteracoes.filter(a => a.acao === 'preco_atualizado').length;
        const totalIgual = alteracoes.filter(a => a.acao === 'sem_alteracao').length;
        const totalAmbiguo = alteracoes.filter(a => a.acao === 'ambiguo').length;

        let resumo = `📋 *Resumo das alterações:*\n\n`;
        if (totalNovos > 0) resumo += `✅ Novo(s): ${totalNovos}\n`;
        if (totalAtualizar > 0) resumo += `🔄 Atualizar: ${totalAtualizar}\n`;
        if (totalIgual > 0) resumo += `⏭️ Sem alteração: ${totalIgual}\n`;
        if (totalAmbiguo > 0) resumo += `⚠️ Ambíguo(s): ${totalAmbiguo}\n`;
        resumo += `\n${linhasAgrupadas}${sufixo}`;

        await salvarContexto(from, {
            ...contexto,
            estado: EstadosFluxo.AGUARDANDO_CONFIRMACAO_ALTERACOES,
            itensPendenteConfirmacao: itensValidos,
            alteracoesPlanejadas: alteracoes,
        });

        await sendTextMessage(from, resumo);
        await delay(300);
        await sendInteractiveButtons(from, `⚡ Confirma as alterações acima?`, [
            { id: 'confirmar_alteracoes_sim', title: '✅ Confirmar Todos' },
            { id: 'editar_item_lista', title: '✏️ Editar um Item' },
            { id: 'confirmar_alteracoes_nao', title: '❌ Cancelar Tudo' },
        ]);


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


/** Sprint 2 #9: INSERT com truncate de segurança e deduplication (Sprint 15) */
async function ingeriCatalogo(lojaId: string, produto: DadosProduto, fonte: string = 'manual'): Promise<{ inserido: boolean }> {
    // Deduplication: ignora se já existe com o mesmo nome e preço nas últimas 24h
    const { data: existente } = await supabase
        .from('catalogo_historico')
        .select('id')
        .eq('loja_id', lojaId)
        .ilike('produto_nome', produto.nome.substring(0, 250))
        .eq('preco', produto.preco)
        .eq('disponivel', true)
        .gte('criado_em', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
        .limit(1);

    if (existente && existente.length > 0) {
        logger.info({ lojaId, nome: produto.nome, preco: produto.preco }, '[Ledger] Duplicata ignorada (mesmo preço nas últimas 24h)');
        return { inserido: false };
    }

    const payload = {
        loja_id:        lojaId,
        produto_nome:   produto.nome.substring(0, 250),
        preco:          produto.preco,
        unidade:        (produto.unidade || 'un').substring(0, 30),
        disponivel:     true,
        fonte_ingestao: fonte,
    };
    const { error } = await supabase.from('catalogo_historico').insert(payload);
    if (error) {
        logger.error({ error }, '[Ledger] Erro no INSERT de catálogo');
        throw new Error('Falha ao gravar produto no banco.');
    }
    return { inserido: true };
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
