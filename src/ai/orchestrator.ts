import { GoogleGenAI, Type, Part } from '@google/genai';
import { z } from 'zod';
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
import { supabaseAdmin as supabase } from '../lib/supabase.js';
import { EstadosFluxo, ContextoSessao, DadosProduto, DadosOferta, AlteracaoPlanejada } from './types.js';
import { detectarEstadoPorWhatsApp } from '../lib/location.js';
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

// interfaces agora centralizadas no types.ts

// interfaces agora centralizadas no types.ts

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

async function detectarIntencaoProativa(texto: string): Promise<boolean> {
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

    const avisoContexto = contexto.perguntaPendente 
        ? `Atenção: o usuário está respondendo à pergunta "${contexto.perguntaPendente}". Ele pode ter digitado APENAS o preço (ex: "5.00"), APENAS a unidade, ou o nome. Extraia o dado e NÃO marque como ruído!` 
        : '';

    const promptMulti = `Você é um extrator de produtos de estoque. Analise a mensagem e extraia TODOS os produtos encontrados.

Regras:
1. Extraia TODOS os produtos da mensagem (ex: "Coca 5,00, guaraná 4,50" = 2 produtos)
2. Preços com vírgula → converter para ponto
3. Nome em Title Case, Unidade máx 30 chars (padrão "un")
4. Se a mensagem contém APENAS o nome de 1 produto sem preço (ex: "Leite"), NÃO marque ruído. Retorne como incompleto=true e falta="preco".
5. Se for ruído real ou conversa fiada, marque ruido_detectado=true.
${avisoContexto}

Retorne formato:
- Se múltiplos: {"ruido_detectado": false, "itens": [{"nome": "Coca Cola", "preco": 5.00, "unidade": "un"}, {outro}]}
- Se ruído: {"ruido_detectado": true}
- Se apenas um incompleto: {"ruido_detectado": false, "incompleto": true, "falta": "preco", "nome": "..."}
- Se apenas um ok: {"ruido_detectado": false, "nome": "...", "preco": ..., "unidade": "..."}

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

        const mergedNome = nullSafe(dados.nome, dadosExistentes?.nome);
        const mergedPreco = nullSafe(dados.preco, dadosExistentes?.preco);

        // Força "incompleto" se faltar nome ou preço nas mesclas (fallback caso o Gemini não faça)
        if (!mergedNome || !mergedPreco || mergedPreco <= 0) {
            dados.incompleto = true;
            if (!mergedPreco || mergedPreco <= 0) dados.falta = 'preco';
            else if (!mergedNome) dados.falta = 'nome';
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
                nome:    mergedNome ?? undefined,
                preco:   mergedPreco ?? undefined,
                unidade: nullSafe(dados.unidade, dadosExistentes?.unidade) ?? undefined,
            };

            await salvarContexto(from, {
                ...contexto,
                // Bug Fix: força a transição de IDLE → AGUARDANDO_DADOS_PRODUTO
                // Sem isso, o próximo "8 reais" chega em estado IDLE e é tratado como ruído
                estado: EstadosFluxo.AGUARDANDO_DADOS_PRODUTO,
                dadosProduto: novosDados,
                perguntaPendente: pergunta,
                retries: novoRetries,
            });
            await sendTextMessage(from, pergunta);
            return;
        }

        // Sprint 10 #3: merge null-safe dos dados completos
        const produto: DadosProduto = {
            nome:    (mergedNome ?? '').substring(0, 250),
            preco:   mergedPreco ?? 0,
            unidade: (nullSafe(dados.unidade, dadosExistentes?.unidade) ?? 'un').substring(0, 30),
        };

        // Validação de segurança antes de avançar
        if (!produto.nome || produto.nome.trim() === '') {
            await sendTextMessage(from, 'Não consegui identificar o nome do produto. Por favor, informe o nome junto com o preço. Ex: *Arroz 8,00*');
            await limparContexto(from);
            return;
        }

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

    /**
     * Calcula o nível de frescor do preço baseado na data de atualização (Sprint Validade)
     */
    function calcularSeloFrescor(dataIso?: string | null): string {
        if (!dataIso) return '🚨 Sem data';
        
        try {
            const data = new Date(dataIso);
            const agora = new Date();
            const diffMs = agora.getTime() - data.getTime();
            const diffDias = Math.floor(diffMs / (1000 * 60 * 60 * 24));
            
            if (diffDias <= 1) return '🟢 Verificado hoje';
            if (diffDias <= 3) return `🟢 Verificado há ${diffDias} dias`;
            if (diffDias <= 7) return `🟡 Atualizado há ${diffDias} dias`;
            
            return `🚨 Preço Desatualizado (há ${diffDias} dias)`;
        } catch {
            return '🚨 Data inválida';
        }
    }

    // ============================================================
    // HELPER VISUAL: formata card de produto para resumo de lote
    // ============================================================
    function formatarCartaoProduto(item: AlteracaoPlanejada, indice: number, fonte: 'texto' | 'foto' | 'audio' = 'texto'): string {
        const SEP = '───────────────';
        const num = `${indice + 1}.`;
        const precoFoto = `R$ ${item.precoFoto.toFixed(2).replace('.', ',')} / ${item.unidade}`;
        const rotuloFonte = fonte === 'foto' ? 'Foto' : fonte === 'audio' ? 'Áudio' : 'Digitado';

        const nomeExibido = (item.acao === 'preco_atualizado' || item.acao === 'sem_alteracao') && item.produtoExistente
            ? item.produtoExistente.produto_nome
            : item.nome;

        let card = `${SEP}\n`;

        if (item.acao === 'novo_cadastro') {
            card += `✅ ${num} *${item.nome}*\n`;
            card += `💰 Preço: *${precoFoto}*\n`;
            card += `📦 Novo cadastro`;
        } else if (item.acao === 'preco_atualizado' && item.produtoExistente) {
            const precoAntigo = `R$ ${item.produtoExistente.preco.toFixed(2).replace('.', ',')} / ${item.produtoExistente.unidade}`;
            const selo = calcularSeloFrescor(item.produtoExistente.updated_at);
            card += `🔄 ${num} *${nomeExibido}*\n`;
            card += `💰 ${rotuloFonte}: *${precoFoto}*\n`;
            card += `📦 Estoque: ${precoAntigo}\n`;
            card += `⏱️ Status: ${selo}\n`;
            card += `↪️ Atualizar preço`;
        } else if (item.acao === 'sem_alteracao' && item.produtoExistente) {
            const precoEstoque = `R$ ${item.produtoExistente.preco.toFixed(2).replace('.', ',')} / ${item.produtoExistente.unidade}`;
            const selo = calcularSeloFrescor(item.produtoExistente.updated_at);
            card += `⏭️ ${num} *${nomeExibido}*\n`;
            card += `💰 ${rotuloFonte}: *${precoFoto}*\n`;
            card += `📦 Estoque: ${precoEstoque}\n`;
            card += `⏱️ Status: ${selo}\n`;
            card += `Sem alteração (confirmado hoje)`;
        } else if (item.acao === 'ambiguo') {
            const numSimilares = item.similares?.length ?? '?';
            card += `⚠️ ${num} *${item.nome}*\n`;
            card += `💰 ${rotuloFonte}: *${precoFoto}*\n`;
            card += `📦 ${numSimilares} produto(s) parecido(s) no estoque\n`;
            card += `Precisa escolher qual atualizar`;
        } else {
            card += `📌 ${num} *${item.nome}*\n`;
            card += `💰 ${rotuloFonte}: *${precoFoto}*`;
        }

        return card;
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
                } else {
                    const maisProximo = similares[0];
                    alteracao.produtoExistente = {
                        id: maisProximo.id,
                        produto_nome: maisProximo.produto_nome,
                        preco: maisProximo.preco,
                        unidade: maisProximo.unidade,
                    };
                    alteracao.acao = maisProximo.preco === item.preco ? 'sem_alteracao' : 'preco_atualizado';
                }
            } else {
                alteracao.acao = 'novo_cadastro';
            }

            alteracoes.push(alteracao);
        }

        if (alteracoes.length === 0) {
            await sendTextMessage(from, 'Nenhum produto válido encontrado.');
            return;
        }

        const totalNovos = alteracoes.filter(a => a.acao === 'novo_cadastro').length;
        const totalAtualizar = alteracoes.filter(a => a.acao === 'preco_atualizado').length;
        const totalIgual = alteracoes.filter(a => a.acao === 'sem_alteracao').length;
        const totalAmbiguo = alteracoes.filter(a => a.acao === 'ambiguo').length;

        const cards = alteracoes.slice(0, 30).map((a, i) => formatarCartaoProduto(a, i)).join('\n');
        const sufixo = alteracoes.length > 30 ? `\n\n...e mais ${alteracoes.length - 30} item(s).` : '';

        const contadorLinhas: string[] = [];
        if (totalNovos > 0) contadorLinhas.push(`✅ ${totalNovos} novo(s)`);
        if (totalAtualizar > 0) contadorLinhas.push(`🔄 ${totalAtualizar} atualizar`);
        if (totalIgual > 0) contadorLinhas.push(`⏭️ ${totalIgual} sem alteração`);
        if (totalAmbiguo > 0) contadorLinhas.push(`⚠️ ${totalAmbiguo} ambíguo(s)`);

        let resumo = `📋 *Resumo — ${alteracoes.length} produto(s)*\n`;
        resumo += contadorLinhas.join('  |  ') + '\n\n';
        resumo += cards + sufixo;

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

    // Sprint Auditoria: Se estamos vindo do IDLE, SEMPRE usamos o Card de Confirmação (lote de 1)
    // para evitar gravações acidentais sem o lojista dar o OK final.
    if (contexto.estado === EstadosFluxo.IDLE) {
        await processarLoteProdutos(from, loja, [produto], contexto);
        return;
    }

    if (similares.length > 0) {
        let listaMsg = '🔍 *Encontrei produtos parecidos no estoque*\nResponda com o número correspondente:\n\n';
        for (let i = 0; i < similares.length; i++) {
            const s = similares[i];
            listaMsg += `───────────────\n`;
            listaMsg += `*${i + 1}* - ${s.produto_nome}\n`;
            listaMsg += `📦 Estoque: R$ ${s.preco.toFixed(2).replace('.', ',')} / ${s.unidade}\n`;
        }
        listaMsg += `───────────────\n`;
        listaMsg += `*0* - Nenhum (cadastrar como novo)`;

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

    try {
        let loja = await buscarPerfilLoja(from);
    let contexto = await lerContexto(from) as ContextoSessao | null;

    // ══════════════════════════════════════════════════════════
    // DISPATCHER DE PERSONA (Onboarding) - Sprint Auditoria
    // ══════════════════════════════════════════════════════════
    if (!loja) {
        const isInteractive = msg.type === 'interactive';
        const buttonId = isInteractive
            ? (msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id || '')
            : '';
        const userText = msg.text?.body?.trim() || '';

        // Se não há contexto, inicia boas vindas
        if (!contexto || (contexto.estado !== EstadosFluxo.ONBOARDING_PERFIL && 
                         contexto.estado !== EstadosFluxo.ONBOARDING_NOME && 
                         contexto.estado !== EstadosFluxo.ONBOARDING_LOCALIZACAO)) {
            
            logger.info({ from }, '[Onboarding] Novo número detectado. Iniciando dispatcher.');
            await salvarContexto(from, { estado: EstadosFluxo.ONBOARDING_PERFIL });
            await sendInteractiveButtons(from, 
                'Olá! 👋 Bem-vindo ao AchaZap.\n\nIdentifiquei que este é seu primeiro contato. Como posso te ajudar hoje?',
                [
                    { id: 'perf_lojista', title: 'Sou Lojista' },
                    { id: 'perf_consumidor', title: 'Quero Comprar' }
                ]
            );
            return;
        }

        // Fluxo: Escolha de Perfil
        if (contexto.estado === EstadosFluxo.ONBOARDING_PERFIL) {
            if (buttonId === 'perf_lojista') {
                await salvarContexto(from, { ...contexto, estado: EstadosFluxo.ONBOARDING_NOME });
                await sendTextMessage(from, 'Excelente! 🚀 Vamos cadastrar sua loja.\n\nQual o *Nome da sua Loja*?');
                return;
            }
            if (buttonId === 'perf_consumidor') {
                await sendTextMessage(from, '👋 A Vitrine AchaZap está chegando em breve na sua região! Por enquanto, este canal é dedicado para lojistas organizarem seus estoques.\n\nFique ligado nas novidades!');
                await limparContexto(from);
                return;
            }
            // Repetir se não escolher opção válida
            await sendInteractiveButtons(from, 'Por favor, selecione uma das opções abaixo:', [
                { id: 'perf_lojista', title: 'Sou Lojista' },
                { id: 'perf_consumidor', title: 'Quero Comprar' }
            ]);
            return;
        }

        // Fluxo: Nome da Loja
        if (contexto.estado === EstadosFluxo.ONBOARDING_NOME) {
            if (!userText || userText.length < 3) {
                await sendTextMessage(from, 'Por favor, digite um nome válido para sua loja (mínimo 3 letras).');
                return;
            }
            await salvarContexto(from, { 
                ...contexto, 
                estado: EstadosFluxo.ONBOARDING_LOCALIZACAO,
                dadosLojista: { nome: userText }
            });
            await sendTextMessage(from, `Legal, *${userText}*!\n\nAgora, qual a sua *Cidade e Bairro*?\nEx: Portel, Castanheira`);
            return;
        }

        // Fluxo: Localização (Cidade e Bairro)
        if (contexto.estado === EstadosFluxo.ONBOARDING_LOCALIZACAO) {
            const extraidos = userText.split(',').map(s => s.trim());
            if (extraidos.length < 2) {
                await sendTextMessage(from, 'Para melhor busca, envie sua Cidade e Bairro separados por vírgula.\nEx: Portel, Castanheira');
                return;
            }

            const [cidade, bairro] = extraidos;
            const estado = detectarEstadoPorWhatsApp(from) || 'PA'; // Fallback PA conforme req anterior

            try {
                const { data: novaLoja, error } = await supabase
                    .from('lojas')
                    .insert({
                        whatsapp: from.startsWith('+') ? from : '+' + from,
                        nome: contexto.dadosLojista?.nome,
                        cidade: cidade,
                        bairro: bairro,
                        estado: estado,
                        ativa: true,
                        saldo_cliques: 100 // Crédito inicial de boas-vindas
                    })
                    .select()
                    .single();

                if (error) throw error;

                await sendTextMessage(from, `🎉 Tudo pronto, *${contexto.dadosLojista?.nome}*!\n\nSua loja foi cadastrada em *${cidade}/${bairro}*.\nVocê ganhou 100 cliques de bônus para começar!`);
                await delay(500);
                await limparContexto(from);
                
                // Recarrega a loja para o fluxo seguir normalmente
                loja = novaLoja;
                // Deixa o código seguir para o envio do Menu Principal abaixo
            } catch (err) {
                logger.error({ err }, '[Onboarding] Erro ao salvar loja');
                await sendTextMessage(from, 'Vish, tive um probleminha técnico ao salvar sua loja. Pode tentar digitar a Cidade e Bairro novamente?');
                return;
            }
        }
    }

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
    // INTERCEPTADOR DE DOCUMENTOS (CSV/Excel) - Sprint 14
    // ══════════════════════════════════════════════════════════
    if (msg.type === 'document') {
        const doc = (msg as any).document;
        const filename = doc?.filename?.toLowerCase() || '';
        const isProcessable = doc?.mime_type === 'text/csv' || 
                             filename.endsWith('.csv') || 
                             filename.endsWith('.xlsx') || 
                             filename.endsWith('.xlsm') || 
                             filename.endsWith('.xls');

        if (doc && isProcessable) {
            await sendTextMessage(from, '⏳ Identifiquei uma planilha! Entrando no modo de extração em lote...');
            const { processarDocumento } = await import('../processor/documentProcessor.js');
            await processarDocumento(msg, from, loja, contexto);
            return;
        }

        // Documento não suportado (PDF, Word, etc) → rejeitar sem cair no fluxo genérico
        await sendTextMessage(from,
            '❌ Esse tipo de arquivo não é suportado.\n\n' +
            '📄 *Formatos aceitos para catálogo:*\n' +
            '  • Planilha Excel: *.xlsx, .xlsm, .xls*\n' +
            '  • Texto CSV: *.csv*\n\n' +
            'Para cadastrar um produto, você também pode:\n' +
            '  📷 Tirar uma *foto* do encarte\n' +
            '  🎙️ Enviar um *áudio* com os dados\n' +
            '  ✍️ *Digitar* o nome, preço e unidade'
        );
        return;
    }

    // ══════════════════════════════════════════════════════════
    // MIDDLEWARE GLOBAL DE FUGA (Sprint 6) — antes de tudo
    // ══════════════════════════════════════════════════════════
    const fugou = await verificarFugaGlobal(msg, buttonId, userMessageText, contexto, from, loja);
    if (fugou) return;
    // Reler contexto após fuga (contexto pode ter sido limpo)
    contexto = await lerContexto(from) as ContextoSessao | null;

    // ══════════════════════════════════════════════════════════
    // INTERCEPTADOR GLOBAL: Comandos especiais (qualquer estado)
    // ══════════════════════════════════════════════════════════
    if (isTextOnly && userMessageText.toLowerCase().trim().startsWith('/revisar')) {
        await processarRevisaoPrecos(from, loja);
        return;
    }

    // ══════════════════════════════════════════════════════════
    // BOTÕES DE NAVEGAÇÃO DO MENU (aceitos mesmo em IDLE)
    // Sprint 12 #2: classificação Ação vs Navegação
    // ══════════════════════════════════════════════════════════
    if (isInteractive && buttonId.startsWith('menu_')) {
        const acao = buttonId.replace('menu_', '');

        if (acao === 'cadastrar' || acao === 'revisar_renovar') {
            const msgInstrucao = acao === 'revisar_renovar'
                ? 'Ótimo! Vamos renovar seus preços. Você pode:\n\n📷 Tirar uma *foto* do encarte ou prateleira\n🎙️ Mandar um *áudio* rápido\n✍️ Ou *digitar* os novos valores (ex: Arroz 8,50)\n\nEstou aguardando!'
                : 'Ótimo! Para cadastrar ou atualizar produtos, você pode:\n\n📷 Tirar uma *foto* do encarte\n🎙️ Mandar um *áudio*\n✍️ Ou *digitar* o nome e preço (ex: Feijão 10,00)\n\nO que deseja enviar?';

            await salvarContexto(from, {
                estado: EstadosFluxo.AGUARDANDO_DADOS_PRODUTO,
                acao: acao,
                perguntaPendente: msgInstrucao,
                retries: 0,
            });
            await sendTextMessage(from, msgInstrucao);
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
    // CENÁRIO: Seleção de item no Relatório de Revisão
    // ══════════════════════════════════════════════════════════
    if (contexto && contexto.estado === EstadosFluxo.AGUARDANDO_SELECAO_REVISAO) {
        const lista = contexto.alteracoesPlanejadas ?? [];

        // Detecta pares "número valor" na mensagem (ex: "1 8,50 2 15,00 3 7,99")
        // Suporta separadores: espaço, tab, vírgula como decimal ou ponto
        const pairsRegex = /(\d+)\s+([\d]+[.,][\d]+|[\d]+)/g;
        const pares: { idx: number; preco: number }[] = [];
        let match: RegExpExecArray | null;

        while ((match = pairsRegex.exec(userMessageText)) !== null) {
            const idx   = parseInt(match[1]!, 10);
            const preco = parseFloat(match[2]!.replace(',', '.'));
            if (!isNaN(idx) && !isNaN(preco) && idx >= 1 && idx <= lista.length && preco > 0) {
                pares.push({ idx, preco });
            }
        }

        if (isTextOnly && pares.length > 0) {
            // Atualiza cada par no banco
            const resultados: string[] = [];
            for (const par of pares) {
                const item = lista[par.idx - 1]!;
                await atualizarPrecoLedger(loja.id, item.nome, par.preco, item.unidade);
                resultados.push(`✅ *${par.idx}. ${item.nome}* → R$ ${par.preco.toFixed(2).replace('.', ',')} / ${item.unidade}`);
                // Marca como atualizado na lista em memória
                item.acao = 'sem_alteracao';
                item.precoFoto = par.preco;
            }

            const atualizadosIds = new Set(pares.map(p => p.idx));
            const pendentes = lista.filter((_: AlteracaoPlanejada, i: number) => !atualizadosIds.has(i + 1));

            // Feedback do que foi atualizado
            const feedbackMsg = `*Preços atualizados:*\n` + resultados.join('\n');

            if (pendentes.length === 0) {
                // Todos concluídos!
                await sendTextMessage(from, feedbackMsg + '\n\n🎉 *Todos os preços estão atualizados!* Obrigado por manter seu catálogo fresquinho.');
                await limparContexto(from);
                await delay(400);
                await enviarMenu(loja.nome, from);
            } else {
                // Ainda há pendentes — mostrar lista atualizada
                let novaLista = `${feedbackMsg}\n\n📋 *Ainda pendentes:*\n`;
                pendentes.forEach((item: AlteracaoPlanejada, i: number) => {
                    const idxOriginal = lista.indexOf(item) + 1;
                    const selo = calcularSeloFrescor(undefined);
                    novaLista += `*${idxOriginal}. ${item.nome}* \u2014 R$ ${item.precoFoto.toFixed(2).replace('.', ',')} / ${item.unidade} ${selo}\n`;
                });
                novaLista += `\n✏️ _Ex: *${pendentes.map((_: AlteracaoPlanejada, i: number) => `${lista.indexOf(pendentes[i]!) + 1} 0,00`).slice(0, 2).join(' ')}_`;

                await salvarContexto(from, {
                    ...contexto,
                    alteracoesPlanejadas: lista,
                });
                await sendTextMessage(from, novaLista);
            }
            return;
        }

        // Entrada não reconhecida — lembrar instrução
        if (isTextOnly && userMessageText.trim().length > 0) {
            const exemplo = lista.slice(0, 2).map((_: AlteracaoPlanejada, i: number) => `${i + 1} 0,00`).join(' ');
            await sendTextMessage(from, `✍️ Digite o número e o preço separados por espaço.\nEx: *${exemplo}*\n\nVocê pode atualizar vários de uma vez!`);
            return;
        }
    }

    // ══════════════════════════════════════════════════════════
    // CENÁRIO 1/8/12: Estado IDLE (Inicia Ingestão Proativa)
    // ══════════════════════════════════════════════════════════
    if (!contexto || contexto.estado === EstadosFluxo.IDLE) {
        
        // 🎙️ Ingestão Proativa: Mídia (Foto/Áudio) em IDLE
        if (isMediaOnly) {
            logger.info({ from }, '[Proativo] Mídia detectada em IDLE. Iniciando extração...');
            await processarMidia(msg, from, loja, { estado: EstadosFluxo.IDLE });
            return;
        }

        // ✍️ Ingestão Proativa: Texto em IDLE
        if (isTextOnly && userMessageText.trim()) {
            
            // Comando de Revisão de Preços (Sprint Validade)
            if (userMessageText.toLowerCase().includes('/revisar')) {
                await processarRevisaoPrecos(from, loja);
                return;
            }

            // Se for apenas uma palavra curta (ex: "Oi", "Tudo bem"), não desperdiça Gemini, manda menu
            if (userMessageText.trim().length < 4) {
                await enviarMenu(loja.nome, from);
                return;
            }

            const ehCadastro = await detectarIntencaoProativa(userMessageText);
            if (ehCadastro) {
                logger.info({ from, text: userMessageText }, '[Proativo] Texto de cadastro detectado em IDLE.');
                // Forçamos o processamento como se estivesse no estado de cadastro
                await processarDadosProduto(from, loja, userMessageText, { estado: EstadosFluxo.IDLE });
                return;
            }

            // Fallback: Se não for cadastro, envia o Menu Principal
            await enviarMenu(loja.nome, from);
            return;
        }

        // Bloqueio de outros tipos (location, contacts) persiste sem processamento proativo
        if (msg.type === 'location' || msg.type === 'contacts') {
            await sendTextMessage(from, '📍 No momento, não consigo processar esse tipo de anexo. Escolha uma opção do menu:');
            await delay(300);
            await enviarMenu(loja.nome, from);
            return;
        }

        // Clique interativo expirado
        if (isInteractive && !buttonId.startsWith('menu_')) {
            await sendTextMessage(from, '⏳ Essa operação expirou. Vamos recomeçar!');
            await delay(300);
            await enviarMenu(loja.nome, from);
            return;
        }

        logger.info({ from, tipo: msg.type }, '[IDLE] Evento ignorado');
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
            const ambiguos = alteracoes.filter((a: AlteracaoPlanejada) => a.acao === 'ambiguo');
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
                if (alt.acao === 'remover') continue; // Pula itens excluídos pelo lojista

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
        
        const textoNum = userMessageText.trim().toLowerCase();
        let numeroDigitado = parseInt(textoNum, 10);
        
        // Mapa NLP rápido
        const mapaPalavras: Record<string, number> = {
            'primeiro': 1, 'um': 1, 'primeira': 1,
            'segundo': 2, 'dois': 2, 'segunda': 2,
            'terceiro': 3, 'três': 3, 'terceira': 3,
            'quarto': 4, 'quatro': 4, 'quarta': 4,
            'quinto': 5, 'cinco': 5, 'quinta': 5,
        };
        
        if (isNaN(numeroDigitado) && mapaPalavras[textoNum]) {
            numeroDigitado = mapaPalavras[textoNum]!;
        }
        
        const numeroInvalido = !isNaN(numeroDigitado) && (numeroDigitado < 1 || numeroDigitado > lista.length);

        if (isNaN(numeroDigitado) || numeroInvalido) {
            // Se for um número digitado explicitamente fora da faixa, nem chama IA
            if (numeroInvalido) {
                await sendTextMessage(from, `⚠️ A opção *${numeroDigitado}* não existe na lista. Por favor, escolha um número de *1* a *${lista.length}*.`);
                return;
            }

            // Sprint 14: NLP Fallback para o Menu Cego na edição (apenas se for texto livre)
            if (userMessageText.trim()) {
                const listaNomes = lista.map((a: AlteracaoPlanejada, i: number) => `${i + 1} - ${a.nome}`).join('\n');
                try {
                    const result = await ai.models.generateContent({
                        model: GEMINI_MODEL,
                        contents: `O usuário quer selecionar um item para EDITAR numa lista de compras/estoque.\nLista:\n${listaNomes}\n\nEle respondeu: "${userMessageText}"\n\nQual o número correspondente ao item que ele quer? Retorne EXATAMENTE o JSON: {"escolha": inteiro, "cancelar": boolean}.\nRegras:\n1. Se ele mencionar um número que NÃO está na lista, retorne "escolha": -1.\n2. Se ele quer cancelar/parar, retorne "cancelar": true.\n3. Se não for possível identificar, retorne "escolha": -1.`,
                        config: { responseMimeType: 'application/json' },
                    });
                    logTokens('nlp_selecao_edicao', from, loja?.id ?? 'unknown', result.usageMetadata);
                    const nlp = parseSafe(NLPEscolhaSchema, result.text || '{}', { escolha: -1, cancelar: false });

                    if (nlp.cancelar === true) {
                        await executarFuga(from, loja);
                        return;
                    }

                    if (Number.isInteger(nlp.escolha) && nlp.escolha >= 1 && nlp.escolha <= lista.length) {
                        // Recomeça o processamento com o número injetado
                        await processMessage({ ...msg, text: { body: String(nlp.escolha) } });
                        return;
                    }
                } catch (e) {
                    logger.error({ e }, '[NLP Selecao Edicao] Erro fallback');
                }
            }
            
            await sendTextMessage(from, `⚠️ Não entendi qual item você quer editar. Digite o número entre *1* e *${lista.length}* ou o nome do produto.`);
            return;
        }
        
        const indiceReal = numeroDigitado - 1;
        const itemEscolhido = lista[indiceReal];
        
        // Se o item tem múltiplas opções (ambíguo), mostra a lista para desempate
        if (itemEscolhido.acao === 'ambiguo' && itemEscolhido.similares && itemEscolhido.similares.length > 1) {
            // ... (mantém lógica de desempate existente) ...
            let msgOpcoes = `⚠️ *Encontrei ${itemEscolhido.similares.length} opções no estoque*\nQual delas é a correspondente?\n\n`;
            itemEscolhido.similares.forEach((s: any, idx: number) => {
                msgOpcoes += `───────────────\n`;
                msgOpcoes += `*${idx + 1}* - ${s.produto_nome}\n`;
                msgOpcoes += `📦 Estoque: R$ ${s.preco.toFixed(2).replace('.', ',')} / ${s.unidade}\n`;
            });
            msgOpcoes += `───────────────\n`;
            msgOpcoes += `*0* - Nenhum (cadastrar como novo)`;
            
            await salvarContexto(from, {
                ...contexto,
                estado: EstadosFluxo.AGUARDANDO_NOVO_PRECO_EDICAO,
                acao: indiceReal.toString() + '_desempate',
                perguntaPendente: msgOpcoes,
            });
            
            await sendTextMessage(from, msgOpcoes);
            return;
        }
        
        // NOVO FLOW: Menu de Edição de Item em vez de pedir preço direto
        await salvarContexto(from, {
            ...contexto,
            estado: EstadosFluxo.AGUARDANDO_NOVO_PRECO_EDICAO, // Reutilizamos esse estado ou um novo? Melhor um novo.
            acao: indiceReal.toString(),
        });

        await sendInteractiveButtons(from, 
            `Item: *${itemEscolhido.nome}*\nPreço atual: R$ ${itemEscolhido.precoFoto.toFixed(2).replace('.', ',')}\n\nO que deseja alterar?`,
            [
                { id: `edit_nome_${indiceReal}`, title: '✏️ Nome' },
                { id: `edit_preco_${indiceReal}`, title: '💰 Preço' },
                { id: `edit_excluir_${indiceReal}`, title: '❌ Excluir' }
            ]
        );
        return;
    }
    
    // ═══════════════════════════════════════════════════════════
    // NOVO ESTADO: Handler de botões de edição de item
    // ═══════════════════════════════════════════════════════════
    if (contexto.estado === EstadosFluxo.AGUARDANDO_NOVO_PRECO_EDICAO && isInteractive && buttonId.startsWith('edit_')) {
        const [,,indiceStr] = buttonId.split('_');
        const indiceReal = parseInt(indiceStr, 10);
        const lista = contexto.alteracoesPlanejadas ?? [];
        const item = lista[indiceReal];

        if (buttonId.startsWith('edit_nome_')) {
            await salvarContexto(from, { 
                ...contexto, 
                estado: EstadosFluxo.AGUARDANDO_NOVO_NOME_EDICAO,
                acao: indiceReal.toString()
            });
            await sendTextMessage(from, `Qual o novo nome para *${item.nome}*?`);
            return;
        }

        if (buttonId.startsWith('edit_preco_')) {
            await sendTextMessage(from, `Qual o novo preço para *${item.nome}*? (Preço na lista: R$ ${item.precoFoto.toFixed(2).replace('.', ',')})`);
            return; // Espera o texto do preço no próximo ciclo (mesmo estado)
        }

        if (buttonId.startsWith('edit_excluir_')) {
            item.acao = 'remover';
            await sendTextMessage(from, `🚫 *${item.nome}* será removido da lista final.`);
            await delay(400);
            await processLoteProdutos(from, loja, lista);
            return;
        }
    }

    if (contexto.estado === EstadosFluxo.AGUARDANDO_NOVO_NOME_EDICAO) {
        const indiceReal = parseInt(contexto.acao ?? '0', 10);
        const lista = contexto.alteracoesPlanejadas ?? [];
        const item = lista[indiceReal];
        const novoNome = userMessageText.trim();

        if (novoNome.length < 3) {
            await sendTextMessage(from, '⚠️ Nome muito curto. Por favor, digite o nome completo do produto.');
            return;
        }

        const nomeAntigo = item.nome;
        item.nome = novoNome;
        
        await sendTextMessage(from, `✅ Nome alterado de *${nomeAntigo}* para *${novoNome}*!`);
        await delay(400);
        await processLoteProdutos(from, loja, lista);
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
            const textoLimpo = userMessageText.trim().toLowerCase();
            let opcaoNum = parseInt(textoLimpo, 10);
            
            // Mapa NLP estático interno
            const mapaPalavras: Record<string, number> = {
                'nenhum': 0, 'novo': 0, 'nenhuma': 0, 'zero': 0,
                'primeiro': 1, 'um': 1, 'primeira': 1,
                'segundo': 2, 'dois': 2, 'segunda': 2,
                'terceiro': 3, 'três': 3, 'terceira': 3,
            };

            if (isNaN(opcaoNum) && mapaPalavras[textoLimpo] !== undefined) {
                opcaoNum = mapaPalavras[textoLimpo]!;
            }
            
            const numInvalidoDesempate = !isNaN(opcaoNum) && (opcaoNum < 0 || opcaoNum > (item.similares?.length ?? 0));

            if (isNaN(opcaoNum) || numInvalidoDesempate) {
                // Travada de segurança: se é número e está fora da faixa, nem chama IA
                if (numInvalidoDesempate) {
                    await sendTextMessage(from, `⚠️ A opção *${opcaoNum}* não existe. Escolha entre *0* e *${item.similares?.length}*.`);
                    return;
                }

                // Sprint 14: NLP Fallback para Desempate na edição
                if (userMessageText.trim()) {
                    const listaSimilares = item.similares!.map((s: any, i: number) => `${i + 1} - ${s.produto_nome}`).concat(['0 - Nenhum (Novo)']).join('\n');
                    try {
                        const result = await ai.models.generateContent({
                            model: GEMINI_MODEL,
                            contents: `O usuário quer escolher um produto similar no estoque.\nOpções:\n${listaSimilares}\n\nResposta: "${userMessageText}"\n\nRegras:\n- Se o usuário mencionar um número que NÃO está na lista, retorne "escolha": -1.\n- Se o usuário der a entender que quer "Nenhum" ou criar um "Novo" produto, a escolha é 0.\n- Retorne JSON: {"escolha": inteiro, "cancelar": boolean}.\n- Só retorne cancelar=true se o usuário quiser explicitamente desistir/cancelar/parar o processo todo.`,
                            config: { responseMimeType: 'application/json' },
                        });
                        logTokens('nlp_desempate_edicao', from, loja?.id ?? 'unknown', result.usageMetadata);
                        const nlp = parseSafe(NLPEscolhaSchema, result.text || '{}', { escolha: -1, cancelar: false });

                        if (nlp.cancelar === true) {
                            await executarFuga(from, loja);
                            return;
                        }

                        if (Number.isInteger(nlp.escolha) && nlp.escolha >= 0 && nlp.escolha <= (item.similares?.length ?? 0)) {
                            await processMessage({ ...msg, text: { body: String(nlp.escolha) } });
                            return;
                        }
                    } catch (e) {
                         logger.error({ e }, '[NLP Desempate Edicao] Erro fallback');
                    }
                }

                await sendTextMessage(from, `⚠️ Escolha inválida. Digite um número entre *0* e *${item.similares?.length}* ou o nome da opção desejada.`);
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
            let novos = 0, atualizados = 0, iguais = 0, ambiguos = 0;
            lista.forEach((item: any) => {
                if (item.acao === 'novo_cadastro') novos++;
                else if (item.acao === 'preco_atualizado') atualizados++;
                else if (item.acao === 'sem_alteracao') iguais++;
                else ambiguos++;
            });

            const contLinhas: string[] = [];
            if (novos > 0) contLinhas.push(`✅ ${novos} novo(s)`);
            if (atualizados > 0) contLinhas.push(`🔄 ${atualizados} atualizar`);
            if (iguais > 0) contLinhas.push(`⏭️ ${iguais} iguais`);
            if (ambiguos > 0) contLinhas.push(`⚠️ ${ambiguos} ambíguo(s)`);

            const cardsAtualizados = lista.map((item: any, i: number) => formatarCartaoProduto(item, i)).join('\n');
            let novoResumo = `📋 *Resumo atualizado — ${lista.length} produto(s)*\n`;
            novoResumo += contLinhas.join('  |  ') + '\n\n';
            novoResumo += cardsAtualizados;
            
            await sendTextMessage(from, `✅ Escolha registrada!\n\n${novoResumo}`);
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
        
        let novos2 = 0, atualizados2 = 0, iguais2 = 0, ambiguos2 = 0;
        lista.forEach((item: any) => {
            if (item.acao === 'novo_cadastro') novos2++;
            else if (item.acao === 'preco_atualizado') atualizados2++;
            else if (item.acao === 'sem_alteracao') iguais2++;
            else ambiguos2++;
        });

        const contLinhas2: string[] = [];
        if (novos2 > 0) contLinhas2.push(`✅ ${novos2} novo(s)`);
        if (atualizados2 > 0) contLinhas2.push(`🔄 ${atualizados2} atualizar`);
        if (iguais2 > 0) contLinhas2.push(`⏭️ ${iguais2} iguais`);
        if (ambiguos2 > 0) contLinhas2.push(`⚠️ ${ambiguos2} ambíguo(s)`);

        const cardsEdit = lista.map((item: any, i: number) => formatarCartaoProduto(item, i)).join('\n');
        let novoResumo = `📋 *Resumo atualizado — ${lista.length} produto(s)*\n`;
        novoResumo += contLinhas2.join('  |  ') + '\n\n';
        novoResumo += cardsEdit;

        await sendTextMessage(from, `${mensagemFeedback}\n\n${novoResumo}`);
        await delay(300);
        await sendInteractiveButtons(from, `O que deseja fazer agora?`, [
            { id: 'confirmar_alteracoes_sim', title: '✅ Confirmar Todos' },
            { id: 'editar_item_lista', title: '✏️ Editar outro' },
            { id: 'confirmar_alteracoes_nao', title: '❌ Cancelar Tudo' },
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

            // Guarda proteção: valida que o contexto ainda está íntegro
            if (!produto || !produto.nome || produto.nome.trim() === '') {
                logger.error({ from, contexto }, '[acao_atualizar] Contexto inválido — produto sem nome');
                await limparContexto(from);
                await sendTextMessage(from, '⏳ Sessão expirada. Por favor, comece novamente pelo menu.');
                await delay(300);
                await enviarMenu(loja.nome, from);
                return;
            }

            if (buttonId === 'acao_atualizar' && (produto.preco === null || produto.preco === undefined)) {
                logger.error({ from, produto }, '[acao_atualizar] Preço ausente no contexto');
                await limparContexto(from);
                await sendTextMessage(from, '⏳ Sessão expirada. Por favor, comece novamente enviando o produto com o preço.');
                await delay(300);
                await enviarMenu(loja.nome, from);
                return;
            }

            // Sprint 3 #6 / Sprint 4 #5: limpar estado ANTES do banco (race condition)
            await limparContexto(from);

            if (buttonId === 'acao_atualizar') {
                // Sprint 3 #2: LEDGER — INSERT nova linha, jamais UPDATE
                await atualizarPrecoLedger(loja.id, produto.nome, produto.preco, produto.unidade);
                await sendTextMessage(from, `✅ Preço de *${produto.nome}* atualizado para R$ ${Number(produto.preco).toFixed(2).replace('.', ',')}!`);
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

    // Fallback Final: se nada capturou, envia menu para evitar silêncio (Zero-Silence)
    logger.warn({ from, estado: contexto?.estado }, '[processMessage] Fallback Zero-Silence acionado');
    await limparContexto(from);
    if (loja) await enviarMenu(loja.nome, from);
    else await sendTextMessage(from, 'Olá! Digite qualquer coisa para começar.');

    } catch (err: any) {
        logger.error({ err, from }, '🛡️ [Garantia de Resposta] Erro crítico no orquestrador');
        
        // Anti-vácuo: Resposta amigável em caso de erro sistêmico
        try {
            await sendTextMessage(from, '🚨 *Ops! Tivemos um soluço técnico.*\n\nJá estamos resolvendo! Por favor, tente novamente em um minuto ou digite "Menu".');
        } catch (sendErr) {
            logger.error({ sendErr }, 'Falha ao enviar erro de fallback');
        }
    }
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
        await sendTextMessage(from, '👀 Recebi sua mídia! Me dê uns segundinhos enquanto leio os dados...');
        
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
                } else {
                    const maisProximo = similares[0];
                    alteracao.produtoExistente = {
                        id: maisProximo.id,
                        produto_nome: maisProximo.produto_nome,
                        preco: maisProximo.preco,
                        unidade: maisProximo.unidade,
                    };
                    alteracao.acao = maisProximo.preco === item.preco ? 'sem_alteracao' : 'preco_atualizado';
                }
            } else {
                alteracao.acao = 'novo_cadastro';
            }

            alteracoes.push(alteracao);
        }

        if (alteracoes.length === 0) {
            await sendTextMessage(from, 'Nenhum produto válido encontrado.');
            await limparContexto(from);
            await enviarMenu(loja.nome, from);
            return;
        }

        await processLoteProdutos(from, loja, alteracoes, mimeType.startsWith('image') ? 'foto' : 'audio');

    } catch (err) {
        logger.error({ err, from }, '[Erro multimodal]');
        await sendTextMessage(from, '😕 Não consegui processar o arquivo. Por favor, *digite* o Nome, Preço e Unidade do produto.');
        await renovarTTLContexto(from);
    }
}

/**
 * Consolida as alterações planejadas, gera o card de resumo e envia os botões de confirmação.
 * Reutilizado após extração e após edições manuais do lojista.
 */
async function processLoteProdutos(from: string, loja: any, alteracoes: AlteracaoPlanejada[], fonte: 'foto' | 'audio' | 'manual' = 'manual'): Promise<void> {
    const listaAtiva = alteracoes.filter(a => a.acao !== 'remover');

    if (listaAtiva.length === 0) {
        await sendTextMessage(from, 'Ø A lista de produtos está vazia.');
        await limparContexto(from);
        await enviarMenu(loja.nome, from);
        return;
    }

    const totalNovos = listaAtiva.filter(a => a.acao === 'novo_cadastro').length;
    const totalAtualizar = listaAtiva.filter(a => a.acao === 'preco_atualizado').length;
    const totalIgual = listaAtiva.filter(a => a.acao === 'sem_alteracao').length;
    const totalAmbiguo = listaAtiva.filter(a => a.acao === 'ambiguo').length;

    const cards = listaAtiva.slice(0, 30).map((a, i) => {
        return formatarCartaoProduto(a, i, fonte === 'manual' ? 'foto' : fonte);
    }).join('\n');
    const sufixo = listaAtiva.length > 30 ? `\n\n...e mais ${listaAtiva.length - 30} item(s).` : '';

    const contLinhas: string[] = [];
    if (totalNovos > 0) contLinhas.push(`✅ ${totalNovos} novo(s)`);
    if (totalAtualizar > 0) contLinhas.push(`🔄 ${totalAtualizar} atualizar`);
    if (totalIgual > 0) contLinhas.push(`⏭️ ${totalIgual} sem alteração`);
    if (totalAmbiguo > 0) contLinhas.push(`⚠️ ${totalAmbiguo} ambíguo(s)`);

    let resumo = `📋 *Resumo Atualizado — ${listaAtiva.length} produto(s)*\n`;
    resumo += contLinhas.join('  |  ') + '\n\n';
    resumo += cards + sufixo;

    await salvarContexto(from, {
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

    // ── Fallback: full-scan em catalogo_ativo (1 linha por produto, sem DISTINCT ON) ──
    if (candidatos.length === 0) {
        const { data, error } = await supabase
            .from('catalogo_ativo')
            .select('id, produto_nome, preco, unidade, updated_at')
            .eq('loja_id', lojaId)
            .eq('disponivel', true);

        if (error || !data || data.length === 0) return [];
        candidatos = data;
        logger.info({ lojaId, totalProdutos: candidatos.length }, '[Similares] Full-scan em catalogo_ativo ativado');
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


/**
 * Ingere produto no catalogo_ativo via UPSERT (1 linha por produto).
 * Se houve mudança de preço, registra trilha de auditoria no catalogo_historico.
 * Deduplication: ignora se mesmo nome+preço já está ativo no snapshot.
 */
async function ingeriCatalogo(lojaId: string, produto: DadosProduto, fonte: string = 'manual'): Promise<{ inserido: boolean }> {
    const nomeSeguro    = produto.nome.substring(0, 250);
    const unidadeSegura = (produto.unidade || 'un').substring(0, 30);

    // ── Deduplication: busca estado atual no snapshot ──
    const { data: ativo } = await supabase
        .from('catalogo_ativo')
        .select('id, preco')
        .eq('loja_id', lojaId)
        .ilike('produto_nome', nomeSeguro)
        .eq('disponivel', true)
        .limit(1)
        .maybeSingle();

    const precoMudou = !ativo || Math.abs(Number(ativo.preco) - produto.preco) > 0.001;

    if (!precoMudou && ativo) {
        // Sprint Validade: preço igual, mas renovamos o timestamp de confirmação
        logger.info({ lojaId, nome: nomeSeguro }, '[Ledger] Renovando selo de frescor (preço igual)');
        await supabase
            .from('catalogo_ativo')
            .update({ updated_at: new Date().toISOString() })
            .eq('id', ativo.id);
        return { inserido: false };
    }

    // ── UPSERT no catálogo ativo (snapshot sempre atualizado) ──
    const { data: upserted, error: upsertError } = await supabase
        .from('catalogo_ativo')
        .upsert(
            {
                loja_id:        lojaId,
                produto_nome:   nomeSeguro,
                preco:          produto.preco,
                unidade:        unidadeSegura,
                disponivel:     true,
                fonte_ingestao: fonte,
                updated_at:     new Date().toISOString(),
            },
            { onConflict: 'loja_id,produto_nome', ignoreDuplicates: false }
        )
        .select('id')
        .single();

    if (upsertError || !upserted) {
        logger.error({ error: upsertError }, '[Ledger] Erro no UPSERT de catalogo_ativo');
        throw new Error('Falha ao gravar produto no banco.');
    }

    // ── Trilha de auditoria no histórico (append-only) ──
    await supabase.from('catalogo_historico').insert({
        loja_id:        lojaId,
        produto_id:     upserted.id,
        produto_nome:   nomeSeguro,
        preco:          produto.preco,
        unidade:        unidadeSegura,
        disponivel:     true,
        fonte_ingestao: fonte,
    });

    return { inserido: true };
}

/**
 * Atualiza preço no snapshot (catalogo_ativo via UPSERT) e
 * registra o evento de mudança no ledger histórico (append-only).
 */
async function atualizarPrecoLedger(lojaId: string, produtoNome: string, novoPreco: number, unidade: string): Promise<void> {
    // Guards de segurança — nunca deixar undefined/null chegar no banco
    if (!produtoNome || !lojaId) {
        logger.error({ lojaId, produtoNome }, '[Ledger] atualizarPrecoLedger chamado com dados inválidos');
        throw new Error('Dados inválidos para atualizar preço.');
    }
    const nomeSeguro    = String(produtoNome).substring(0, 250);
    const unidadeSegura = String(unidade || 'un').substring(0, 30);
    const precoSeguro   = Number(novoPreco) || 0;

    // ── Atualiza snapshot ──
    // Usa atualizado_em (coluna nativa do schema) para compatibilidade com o Supabase.
    // updated_at é alias adicionado posteriormente e pode falhar por cache de schema.
    const agora = new Date().toISOString();
    const { data: upserted, error: upsertError } = await supabase
        .from('catalogo_ativo')
        .upsert(
            {
                loja_id:        lojaId,
                produto_nome:   nomeSeguro,
                preco:          precoSeguro,
                unidade:        unidadeSegura,
                disponivel:     true,
                fonte_ingestao: 'manual',
                atualizado_em:  agora,
            },
            { onConflict: 'loja_id,produto_nome', ignoreDuplicates: false }
        )
        .select('id')
        .single();

    if (upsertError) {
        logger.error({ error: upsertError }, '[Ledger] Erro ao atualizar preço em catalogo_ativo');
        throw new Error('Falha ao atualizar preço.');
    }

    // ── Registra evento no histórico ──
    await supabase.from('catalogo_historico').insert({
        loja_id:        lojaId,
        produto_id:     upserted?.id,
        produto_nome:   nomeSeguro,
        preco:          precoSeguro,
        unidade:        unidadeSegura,
        disponivel:     true,
        fonte_ingestao: 'manual',
    });
}

/**
 * Soft Delete: marca produto como indisponível no snapshot (catalogo_ativo)
 * e registra o evento de remoção na trilha de auditoria (catalogo_historico).
 * Proteção contra redundância: ignora se já está fora de estoque.
 */
async function retirarEstoqueLedger(lojaId: string, produtoNome: string, unidadeConhecida: string): Promise<void> {
    // ── Busca snapshot atual para verificar estado e copiar preço ──
    const { data: ativo } = await supabase
        .from('catalogo_ativo')
        .select('id, preco, unidade, disponivel')
        .eq('loja_id', lojaId)
        .ilike('produto_nome', `%${produtoNome}%`)
        .limit(1)
        .maybeSingle();

    // Proteção contra redundância
    if (ativo && ativo.disponivel === false) {
        logger.info({ lojaId, produtoNome }, '[Ledger] Produto já fora de estoque — sem ação');
        return;
    }

    const precoConhecido    = ativo?.preco ?? 0;
    const unidadeConhecidaFinal = (ativo?.unidade || unidadeConhecida || 'un').substring(0, 30);
    const nomeSeguro        = produtoNome.substring(0, 250);

    // ── Soft Delete no snapshot ──
    if (ativo?.id) {
        const { error: updateError } = await supabase
            .from('catalogo_ativo')
            .update({ disponivel: false })
            .eq('id', ativo.id);

        if (updateError) {
            logger.error({ error: updateError }, '[Ledger] Erro no Soft Delete em catalogo_ativo');
            throw new Error('Falha ao retirar produto do estoque.');
        }
    }

    // ── Registra evento de remoção no histórico ──
    await supabase.from('catalogo_historico').insert({
        loja_id:        lojaId,
        produto_id:     ativo?.id,
        produto_nome:   nomeSeguro,
        preco:          precoConhecido,
        unidade:        unidadeConhecidaFinal,
        disponivel:     false,
        fonte_ingestao: 'manual',
    });
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
    const { data } = await supabase.from('ofertas_desconto').select('*').eq('loja_id', lojaId).gte('validade', new Date().toISOString().split('T')[0]);
    return data || [];
}

/**
 * Busca os itens com preços mais antigos para o Lojista revisar (Sprint Validade)
*/
async function processarRevisaoPrecos(from: string, loja: any): Promise<void> {
    // Busca em duas etapas: NULLs primeiro, depois os mais antigos.
    const [{ data: semData }, { data: comData }] = await Promise.all([
        supabase
            .from('catalogo_ativo')
            .select('produto_nome, preco, unidade, updated_at')
            .eq('loja_id', loja.id)
            .eq('disponivel', true)
            .is('updated_at', null)
            .limit(10),
        supabase
            .from('catalogo_ativo')
            .select('produto_nome, preco, unidade, updated_at')
            .eq('loja_id', loja.id)
            .eq('disponivel', true)
            .not('updated_at', 'is', null)
            .order('updated_at', { ascending: true })
            .limit(10),
    ]);

    const todos = [...(semData ?? []), ...(comData ?? [])];
    
    // Filtro inteligente: Só mostra o que realmente PRECISA de revisão (6 dias ou mais, ou NULL)
    const pendentes = todos.filter(item => {
        if (!item.updated_at) return true;
        const data = new Date(item.updated_at);
        const agora = new Date();
        const diffDias = Math.floor((agora.getTime() - data.getTime()) / (1000 * 60 * 60 * 24));
        return diffDias >= 6;
    }).slice(0, 8); // Mostra os 8 mais críticos

    if (pendentes.length === 0) {
        await sendTextMessage(from, '✅ *Tudo verdinho!* Todos os seus preços foram atualizados recentemente e estão com selo de confiança dos clientes. Bom trabalho!');
        return;
    }

    let relatorio = `📋 *Relatório de Vencimento de Preços*\n`;
    relatorio += `${pendentes.length} item(s) precisam de atenção:\n\n`;

    const alteracoes: AlteracaoPlanejada[] = [];

    pendentes.forEach((item, i) => {
        const selo = calcularSeloFrescor(item.updated_at);
        relatorio += `*${i+1}. ${item.produto_nome}*\n💰 R$ ${Number(item.preco).toFixed(2).replace('.', ',')} / ${item.unidade} ${selo}\n`;
        alteracoes.push({
            nome: item.produto_nome,
            precoFoto: Number(item.preco),
            unidade: item.unidade,
            acao: 'preco_atualizado'
        });
    });

    // Gera exemplo dinâmico com os 2 primeiros itens
    const ex1 = pendentes.length >= 1 ? `1 ${Number(pendentes[0]!.preco).toFixed(2).replace('.', ',')}` : '1 0,00';
    const ex2 = pendentes.length >= 2 ? ` 2 ${Number(pendentes[1]!.preco).toFixed(2).replace('.', ',')}` : '';
    relatorio += `\n✍️ Digite o número e o novo preço.\nEx: *${ex1}${ex2}*\n_Você pode atualizar vários de uma vez!_`;

    await salvarContexto(from, {
        estado: EstadosFluxo.AGUARDANDO_SELECAO_REVISAO,
        alteracoesPlanejadas: alteracoes,
        perguntaPendente: 'Digite o número e o novo preço.',
    });

    await sendTextMessage(from, relatorio);
}
