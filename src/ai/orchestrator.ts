import { GoogleGenAI, Type, Part } from '@google/genai';
import { z } from 'zod';
import {
    sendTextMessage,
    downloadMedia,
    sendInteractiveButtons,
    sendListMessage,
    sendCTAUrlMessage,
    sendReaction,
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
    incrementarBucketMidia,
    ttlBucketMidia,
    temAvisoSpam,
    setAvisoSpam,
} from '../lib/redis-cloud.js';
import { supabaseAdmin as supabase } from '../lib/supabase.js';
import { enviarLogAuditoria } from '../lib/audit.js';
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

// ── Skills importadas (Fase 1 de Modularização) ──────────────────────────────
import { buscarProdutosSimilares, ingeriCatalogo, atualizarPrecoLedger, retirarEstoqueLedger, gerarEmbedding } from './skills/catalog-ledger.js';
import { obterEstatisticas, criarOferta, buscarOfertasAtivas } from './skills/store-services.js';
import { detectarFugaNLP, detectarIntencaoProativa, refinarCandidatosBusca, extrairListaCompras } from './skills/intent-detector.js';
import { processarRevisaoPrecos, calcularSeloFrescor } from './skills/revisor.js';
import { processarMidia, processLoteProdutos, formatarCartaoProduto } from './skills/vision-processor.js';
// ─────────────────────────────────────────────────────────────────────────────


const delay        = (ms: number) => new Promise(res => setTimeout(res, ms));

// interfaces agora centralizadas no types.ts

// interfaces agora centralizadas no types.ts

// ============================================================
// MENU PRINCIPAL
// ============================================================
const MENU_SECTIONS = [
    {
        title: 'Gestão de Estoque',
        rows: [
            { id: 'menu_cadastrar', title: 'Cadastrar/Atualizar', description: 'Adicionar ou atualizar produtos' },
            { id: 'menu_revisar', title: 'Revisar Preços', description: 'Ver preços desatualizados' },
        ],
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

    // 🛡️ GUARD: Estados de onboarding e modo consumidor são IMUNES à fuga global.
    // Nesses estados, o bot está coletando dados — qualquer mensagem é válida.
    const estadosImunes = new Set([
        EstadosFluxo.ONBOARDING_PERFIL,
        EstadosFluxo.ONBOARDING_NOME,
        EstadosFluxo.ONBOARDING_LOCALIZACAO,
        EstadosFluxo.ONBOARDING_CATEGORIA,
        EstadosFluxo.ONBOARDING_CONSUMIDOR_LOCALIZACAO,
        EstadosFluxo.CONSUMIDOR_IDLE,
    ]);
    if (contexto && estadosImunes.has(contexto.estado)) {
        return false;
    }

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


// detectarFugaNLP e detectarIntencaoProativa -> src/ai/skills/intent-detector.ts

async function executarFuga(from: string, loja: any): Promise<void> {
    await limparContexto(from); // Sprint 6 #3: expurgo total — zero zumbis
    await sendTextMessage(from, 'Sem problemas! Operação cancelada. 🧹 O que gostaria de fazer agora?');
    await delay(300);
    if (loja) {
        await enviarMenu(loja.nome, from);
    } else {
        await sendTextMessage(from, 'O que você está procurando hoje?');
    }
}

// ============================================================
// PROCESSAMENTO DE DADOS DO PRODUTO (Cenários 2/3/10)
// ============================================================
async function processarDadosProduto(from: string, loja: any, userMessageText: string, contexto: ContextoSessao): Promise<void> {
    logger.debug({ from, userMessageText }, '[Cenário 2/3/10] Processando produto');

    const dadosExistentes = contexto.dadosProduto;
    const retries = contexto.retries ?? 0;

    // Armadilha 1: é disparada no call site (processMessage) onde msg está disponível

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
        // Armadilha 12: Sanitização de Vírgula Brasileira
        // Converte preços com vírgula (ex: 15,90) para ponto (15.90) dentro do JSON
        // ANTES de passar pelo Zod, evitando rejeição de tipo em respostas numéricas.
        const rawTextSanitizado = rawText.replace(/"preco"\s*:\s*([\d]+),([\d]+)/g, '"preco": $1.$2');
        logTokens('extrair_produto', from, loja?.id ?? 'unknown', result.usageMetadata);
        logger.debug({ from, rawTextSanitizado }, '[Gemini] extração produto');

        // Tenta extrair múltiplos produtos primeiro
        const dadosMulti = parseSafe(MultiProdutosTextoSchema, rawTextSanitizado, {
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

        const dados = parseSafe(ProdutoExtraidoSchema, rawTextSanitizado, {
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

            // UX Melhoria 2: Se faltou apenas o preço e há um único similar no estoque,
            // perguntar se é o mesmo produto antes de pedir o preço do zero.
            if (dados.falta === 'preco' && (dados.nome || dadosExistentes?.nome)) {
                const nomeBusca = dados.nome || dadosExistentes?.nome || '';
                const similares = await buscarProdutosSimilares(loja.id, nomeBusca);
                if (similares.length === 1) {
                    const s = similares[0];
                    await salvarContexto(from, {
                        ...contexto,
                        estado: EstadosFluxo.AGUARDANDO_ACAO_SIMILARES,
                        dadosProduto: { nome: nomeBusca, preco: 0, unidade: s.unidade },
                        similaresEncontrados: similares,
                        acao: 'cadastrar',
                        retries: 0,
                    });
                    await sendTextMessage(from, `Já tenho *${s.produto_nome}* no seu estoque por R$ ${s.preco.toFixed(2).replace('.', ',')} / ${s.unidade}.`);
                    await delay(300);
                    await sendInteractiveButtons(from, 'O que deseja fazer?', [
                        { id: '1', title: '🔄 Atualizar Preço' },
                        { id: '0', title: '🆕 É um produto diferente' },
                        { id: 'btn_cancelar', title: '❌ Cancelar' },
                    ]);
                    return;
                }
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

        // Armadilha 11: Detector de Embalagem Coletiva sem Quantidade
        // Palavras que indicam fardo/pacote sem especificar a quantidade interna
        const TERMOS_EMBALAGEM = /\b(fardo|caixa|bandeja|pack|pacot[eo]|cesta|kit|combo|leve\s*\d)\b/i;
        const TEM_QUANTIDADE_INTERNA = /\b(\d+\s*(un|und|unidade|lata|lat|garraf|g|ml|kg|pç|peca|peça)s?)\b/i;

        if (TERMOS_EMBALAGEM.test(produto.nome) && !TEM_QUANTIDADE_INTERNA.test(produto.nome) && !TEM_QUANTIDADE_INTERNA.test(userMessageText)) {
            // Guarda o produto no contexto e pergunta a quantidade
            await salvarContexto(from, {
                ...contexto,
                estado: EstadosFluxo.AGUARDANDO_QUANTIDADE_EMBALAGEM,
                dadosProduto: produto,
                perguntaPendente: 'Quantas unidades tem nessa embalagem?'
            });
            await sendTextMessage(from,
                `Para seu cliente saber se vale a pena, me diz: o preço de *R$ ${produto.preco.toFixed(2).replace('.', ',')}* do *${produto.nome}* é para *quantas unidades*?\n\nEx: _"24 latas"_, _"12 unidades"_, _"6 garrafas"_`);
            return;
        }

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
                } else {
                    const maisProximo = similares[0];
                    alteracao.produtoExistente = {
                        id: maisProximo.id,
                        produto_nome: maisProximo.produto_nome,
                        preco: maisProximo.preco,
                        unidade: maisProximo.unidade,
                        atualizado_em: (maisProximo as any).atualizado_em ?? undefined,
                    };
                    // Herança inteligente: se a unidade extraída for genérica ("un"),
                    // adota a unidade já cadastrada no estoque para evitar inconsistências.
                    if (alteracao.unidade === 'un' && maisProximo.unidade && maisProximo.unidade !== 'un') {
                        alteracao.unidade = maisProximo.unidade;
                    }
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

    // Se veio do IDLE e não há similares: vai direto para lote de 1 (confirmação sem ambiguidade)
    // Se veio do IDLE mas há similares: vai para os botões diretamente (sem o card de resumo intermediário)
    if (contexto.estado === EstadosFluxo.IDLE && similares.length === 0) {
        await processarLoteProdutos(from, loja, [produto], contexto);
        return;
    }

    if (similares.length > 0) {
        await salvarContexto(from, {
            ...contexto,
            estado: EstadosFluxo.AGUARDANDO_ACAO_SIMILARES,
            dadosProduto: produto,
            similaresEncontrados: similares,
            acao: 'cadastrar',
            retries: 0,
        });

        // UX Melhoria 1: Para 1 ou 2 similares, usar botões interativos
        if (similares.length <= 2) {
            const botoes: Array<{ id: string; title: string }> = similares.map((s, i) => ({
                id: String(i + 1),
                title: `✅ ${s.produto_nome.substring(0, 20)}`,
            }));
            botoes.push({ id: '0', title: '🔄 Cadastrar como Novo' });

            const textoSimples = similares
                .map((s, i) => `*${i + 1}* - ${s.produto_nome} (R$ ${s.preco.toFixed(2).replace('.', ',')} / ${s.unidade})`)
                .join('\n');

            await sendTextMessage(from, `🔍 *Produtos parecidos no estoque:*\n\n${textoSimples}\n\nEste é o mesmo produto que você quer atualizar?`);
            await delay(300);
            await sendInteractiveButtons(from, '↩️ Ou cancele para voltar ao menu:', [
                ...botoes,
                { id: 'btn_cancelar', title: '❌ Cancelar' },
            ]);
        } else {
            // 3 ou mais similares: lista numerada + botão de saída
            let listaMsg = '🔍 *Encontrei produtos parecidos no estoque*\nResponda com o número correspondente:\n\n';
            for (let i = 0; i < similares.length; i++) {
                const s = similares[i];
                listaMsg += `───────────────\n`;
                listaMsg += `*${i + 1}* - ${s.produto_nome}\n`;
                listaMsg += `📦 Estoque: R$ ${s.preco.toFixed(2).replace('.', ',')} / ${s.unidade}\n`;
            }
            listaMsg += `───────────────\n`;
            listaMsg += `*0* - Nenhum (cadastrar como novo)`;

            await sendTextMessage(from, listaMsg);
            await delay(300);
            await sendInteractiveButtons(from, 'Ou desista sem alterar nada:', [
                { id: 'btn_cancelar', title: '❌ Cancelar Operação' },
            ]);
        }
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

    const isInteractive = msg.type === 'interactive';
    const isTextOnly    = msg.type === 'text';
    const isMediaOnly   = ['image', 'audio', 'video', 'sticker', 'voice'].includes(msg.type);

    const buttonId = isInteractive
        ? (msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id || '')
        : '';

    const userText = msg.text?.body?.trim() || 
                    (isInteractive ? (msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '') : '') ||
                    '';

    // Grampo de Auditoria — captura exatamente O QUE o usuário enviou
    enviarLogAuditoria({
        whatsapp: from,
        nivel: 'info',
        contexto: 'USER_INPUT',
        mensagem: isInteractive ? `👆 [Botão] "${userText}" (ID: ${buttonId})` :
                  isMediaOnly   ? `📷 [Mídia] Tipo: ${msg.type}` :
                                  `💬 [Texto] "${userText}"`,
        dados: { text: userText, buttonId, type: msg.type }
    });

    // ============================================================
    // OWNER ADMIN TOOLS (Botões de Erro)
    // ============================================================
    if (from === process.env.ACHAZAP_OWNER_NUMBER && isInteractive) {
        if (buttonId.startsWith('admin_diag_')) {
            const targetNumber = buttonId.replace('admin_diag_', '');
            
            const { data: hist } = await supabase.from('historico_mensagens')
                .select('role, content, created_at')
                .eq('whatsapp', targetNumber)
                .order('created_at', { ascending: false })
                .limit(7);

            let doc = `🔬 *Diagnóstico*: ${targetNumber}\n\n`;
            if (hist && hist.length > 0) {
                hist.reverse().forEach((h: any) => {
                    const shortC = h.content.substring(0, 150).replace(/\n/g, ' ');
                    doc += `*[${h.role === 'user' ? 'Lojista' : 'Robô'}]*\n"${shortC}"\n\n`;
                });
            } else {
                doc += 'Nenhum histórico recente.';
            }
            await sendTextMessage(from, doc);
            return;
        }

        if (buttonId.startsWith('admin_mute_')) {
            const origemMute = buttonId.replace('admin_mute_', '');
            cache.set(`admin_mute_${origemMute}`, true, 60 * 60 * 1000); // 1h
            await sendTextMessage(from, `🔇 Alertas de erro da origem *${origemMute}* silenciados por 1 hora.`);
            return;
        }
    }

    try {
        let loja = await buscarPerfilLoja(from);
        let contexto = await lerContexto(from) as ContextoSessao | null;

        // ══════════════════════════════════════════════════════════
        // MIDDLEWARE GLOBAL DE FUGA (Sprint 6) — antes de tudo
        // ══════════════════════════════════════════════════════════
        const fugou = await verificarFugaGlobal(msg, buttonId, userText, contexto, from, loja);
        if (fugou) return;
        // Reler contexto após fuga (contexto pode ter sido limpo)
        contexto = await lerContexto(from) as ContextoSessao | null;

        // ══════════════════════════════════════════════════════════
        // DISPATCHER DE PERSONA (Onboarding) - Sprint Auditoria
        // ══════════════════════════════════════════════════════════
        if (!loja) {

        // Se não há contexto E não é um consumidor já cadastrado (fazer check depois), inicia boas vindas
        // Para simplificar, se não há contexto, a gente deveria tentar buscar usuário tbm.
        // Vou fazer essa busca de usuario se loja for null e contexto for nulo/idle.
        let usuario = null;
        if (!loja && (!contexto || contexto.estado === EstadosFluxo.IDLE)) {
             const whatsappComPlus = from.startsWith('+') ? from : '+' + from;
             const { data } = await supabase.from('usuarios').select('*').eq('whatsapp', whatsappComPlus).maybeSingle();
             usuario = data;
             if (usuario) {
                 contexto = { 
                     estado: EstadosFluxo.CONSUMIDOR_IDLE, 
                     dadosConsumidor: { 
                         cidade: usuario.cidade, 
                         bairro: usuario.bairro, 
                         estado: usuario.estado, 
                         nome: usuario.nome 
                     } 
                 };
             }
        }

        if (!loja && !usuario) {
            if (!contexto || (
                 contexto.estado !== EstadosFluxo.ONBOARDING_PERFIL && 
                 contexto.estado !== EstadosFluxo.ONBOARDING_NOME && 
                 contexto.estado !== EstadosFluxo.ONBOARDING_LOCALIZACAO &&
                 contexto.estado !== EstadosFluxo.ONBOARDING_CATEGORIA &&
                 contexto.estado !== EstadosFluxo.ONBOARDING_CONSUMIDOR_LOCALIZACAO &&
                 contexto.estado !== EstadosFluxo.CONSUMIDOR_IDLE
            )) {
                
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
                await salvarContexto(from, { ...contexto, estado: EstadosFluxo.ONBOARDING_CONSUMIDOR_LOCALIZACAO });
                await sendTextMessage(from, 'Ótimo! 🛍️ Para te mostrar as melhores ofertas perto de você, qual a sua *Cidade e Bairro*?\n\nEx: Portel, Castanheira');
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

        // Fluxo: Localização Consumidor
        if (contexto.estado === EstadosFluxo.ONBOARDING_CONSUMIDOR_LOCALIZACAO) {
            const extraidos = userText.split(',').map(s => s.trim());
            if (extraidos.length < 2) {
                await sendTextMessage(from, 'Para encontrar as melhores ofertas, preciso da sua Cidade e Bairro separados por vírgula.\nEx: Portel, Castanheira');
                return;
            }

            const [cidade, bairro] = extraidos;
            const estado = detectarEstadoPorWhatsApp(from) || 'PA';

            // Registra o consumidor (se não existir, o upsert cria)
            try {
                const { error } = await supabase.from('usuarios').upsert(
                    {
                        whatsapp: from.startsWith('+') ? from : '+' + from,
                        cidade,
                        bairro,
                        estado,
                    },
                    { onConflict: 'whatsapp' }
                );
                if (error) throw error;
            } catch (err) {
                logger.error({ err }, '[Onboarding] Erro ao cadastrar consumidor');
            }

            await salvarContexto(from, { 
                ...contexto, 
                estado: EstadosFluxo.CONSUMIDOR_IDLE,
                dadosConsumidor: { ...contexto.dadosConsumidor, cidade, bairro, estado }
            });

            await sendTextMessage(from, `🎉 Perfeito! A partir de agora, o AchaZap vai procurar ofertas em *${cidade}*.\n\nO que você quer comprar hoje?\nEx: *"Onde tem Picanha?"* ou *"Pizza"*`);
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
            const estado = detectarEstadoPorWhatsApp(from) || 'PA';

            await salvarContexto(from, { 
                ...contexto, 
                estado: EstadosFluxo.ONBOARDING_CATEGORIA,
                dadosLojista: { ...contexto.dadosLojista, cidade, bairro, estado }
            });

            const CATEGORIAS_MENU = [
                {
                    title: 'Mais Comuns',
                    rows: [
                        { id: 'cat_supermercado', title: 'Supermercado', description: 'Mercadinhos, Mercearias' },
                        { id: 'cat_farmacia',     title: 'Farmácia',     description: 'Drogarias' },
                        { id: 'cat_restaurante',  title: 'Alimentação',  description: 'Refeições, Lanches, Pizza' },
                        { id: 'cat_padaria',      title: 'Padaria/Açougue',description: 'Pães, Carnes, Frios' },
                        { id: 'cat_vestuario',    title: 'Moda/Calçados',description: 'Roupas, Sapatos' }
                    ]
                },
                {
                    title: 'Outros Setores',
                    rows: [
                        { id: 'cat_construcao',   title: 'Construção',   description: 'Ferragens, Tintas' },
                        { id: 'cat_pet',          title: 'Pet Shop',     description: 'Ração, Acessórios' },
                        { id: 'cat_eletronicos',  title: 'Eletrônicos',  description: 'Celulares, TV, PC' },
                        { id: 'cat_utilidades',   title: 'Utilidades',   description: 'Cosméticos, Variedades' },
                        { id: 'cat_outro',        title: 'Outro',        description: 'Outras opções' }
                    ]
                }
            ];

            await sendListMessage(from, 'Show! Para finalizar, qual a *Categoria* da sua loja?', 'Escolha a categoria', CATEGORIAS_MENU);
            return;
        }

        // Fluxo: Categoria da Loja
        if (contexto.estado === EstadosFluxo.ONBOARDING_CATEGORIA) {
            const categoriaKey = buttonId.startsWith('cat_') ? buttonId.replace('cat_', '') : '';
            
            if (!categoriaKey) {
                // Se o lojista digitou texto em vez de clicar na lista, tenta um fuzzy ou pede denovo
                await sendTextMessage(from, 'Por favor, selecione uma categoria da lista para continuarmos.');
                return;
            }

            try {
                const { data: novaLoja, error } = await supabase
                    .from('lojas')
                    .insert({
                        whatsapp: from.startsWith('+') ? from : '+' + from,
                        nome: contexto.dadosLojista?.nome,
                        cidade: contexto.dadosLojista?.cidade,
                        bairro: contexto.dadosLojista?.bairro,
                        estado: contexto.dadosLojista?.estado,
                        categoria: categoriaKey,
                        ativa: true,
                        saldo_cliques: 100
                    })
                    .select()
                    .single();

                if (error) throw error;

                await sendTextMessage(from,
                    `🎉 Tudo pronto, *${contexto.dadosLojista?.nome}*!\n\n` +
                    `Sua loja foi cadastrada como *${categoriaKey.toUpperCase()}* em *${contexto.dadosLojista?.cidade}*.\n` +
                    `Você ganhou *100 cliques de bônus* para começar! 🎁`
                );
                await delay(800);
                await sendTextMessage(from,
                    `📦 *Agora vamos montar seu catálogo!*\n\n` +
                    `Você pode cadastrar seus produtos de 3 formas:\n\n` +
                    `📷 *Foto* — Mande a foto de um produto, ou de um encarte/cardápio inteiro (eu leio vários produtos de uma vez só)!\n` +
                    `🎙️ *Áudio* — Me mande um áudio falando o nome e o preço.\n` +
                    `✍️ *Texto* — Digite direto. Ex: _Feijão Carioca 8,50_\n\n` +
                    `Comece agora! Quanto mais produtos, mais clientes vão te encontrar. 🚀`
                );
                await delay(500);
                await limparContexto(from);
                
                loja = novaLoja;
            } catch (err) {
                logger.error({ err }, '[Onboarding] Erro ao salvar loja');
                await sendTextMessage(from, 'Vish, tive um probleminha técnico ao salvar sua loja. Pode tentar selecionar a Categoria novamente?');
                return;
            }
        }
    } // Closes if (!loja && !usuario)
    } // Closes if (!loja)

    const userMessageText = userText;

    logger.debug({ from, estado: contexto?.estado ?? 'IDLE', tipo: msg.type, texto: userMessageText || '[media]' }, '[processMessage]');

    // ══════════════════════════════════════════════════════════
    // MODO CONSUMIDOR: BLIND SEARCH + CROSS SELL
    // ══════════════════════════════════════════════════════════
    const isUsuarioConsumidor = !loja && contexto?.estado === EstadosFluxo.CONSUMIDOR_IDLE;
    
    if (isUsuarioConsumidor) {
        if (buttonId.startsWith('revelar_')) {
            const [, idOferta, idLoja] = buttonId.split('_');
            
            const { data: usuarioData } = await supabase.from('usuarios').select('id').eq('whatsapp', from.startsWith('+') ? from : '+' + from).maybeSingle();
            const usuarioId = usuarioData?.id || '00000000-0000-0000-0000-000000000000';

            const { data } = await supabase.from('lojas').select('whatsapp, nome').eq('id', idLoja).single();

            if (data) {
                // Registrar clique consumido.
                await supabase.from('cliques_consumidos').insert({
                    loja_id: idLoja,
                    usuario_id: usuarioId,
                    produto_ref: 'revelacao',
                    link_token: 'unlock_' + Math.random().toString(36).substring(7),
                    debitado: true
                });

                // Deduzir 1 clique (poderia ser trigger, mas vamos via rpc se precisar ou server.ts já faz isso na api de link).
                // Actually need to check if decrementar_saldo RPC exists. We can just update directly for now since it's a test scale.
                const { error: rpcErr } = await supabase.rpc('decrementar_saldo', { p_loja_id: idLoja, p_qtd: 1 });
                if (rpcErr) {
                    const { data: l } = await supabase.from('lojas').select('saldo_cliques').eq('id', idLoja).single();
                    if(l) await supabase.from('lojas').update({ saldo_cliques: Math.max(0, l.saldo_cliques - 1) }).eq('id', idLoja);
                }

                await sendTextMessage(from, `🎉 *Nome Revelado!*\n\nA opção escolhida foi a loja *${data.nome}*.\n\n📲 Pode mandar o Zap pra eles: ${data.whatsapp}\n\nDica: Diga que veio pelo AchaZap para eles manterem as ofertas!`);
            } else {
                await sendTextMessage(from, 'Loja indisponível.');
            }
            return;
        }

        if (isTextOnly && userMessageText) {
            const txtLimpo = userMessageText.trim().toLowerCase();
            const greetings = ['oi', 'olá', 'ola', 'oie', 'bom dia', 'boa tarde', 'boa noite', 'tudo bem'];
            if (greetings.includes(txtLimpo) || txtLimpo.length < 3) {
                await sendTextMessage(from, 'Olá! O que você quer comprar hoje? Pode digitar ex: "Pizza", "Leite", etc.');
                return;
            }

            const listaIntencao = await extrairListaCompras(userMessageText);
            const nomesItens = listaIntencao.map(i => i.item).join(', ');

            await sendTextMessage(from, `🔍 Procurando *${nomesItens}* mais baratos e próximos de você em ${contexto!.dadosConsumidor?.bairro}...`);
            await delay(1500);

            // ── Fase 1: Busca silenciosa para todos os itens ────────────────
            const itensAchados: Array<{ intencao: typeof listaIntencao[0]; oferta: any }> = [];
            const itensAmbiguos: Array<{ intencao: typeof listaIntencao[0]; opcoes: any[] }> = [];
            const itensNaoEncontrados: string[] = [];

            for (const intencao of listaIntencao) {
                // Monta o termo de busca combinando item + atributos conhecidos do consumidor
                const termoBusca = [intencao.item, intencao.marca, intencao.especificacao, intencao.tamanho]
                    .filter(Boolean).join(' ').trim();

                const { data: ofertasTextuais } = await supabase.rpc('buscar_ofertas', {
                    p_cidade: contexto!.dadosConsumidor?.cidade,
                    p_bairro: contexto!.dadosConsumidor?.bairro,
                    p_estado: contexto!.dadosConsumidor?.estado || 'PA',
                    p_query: termoBusca
                });

                let ofertas = ofertasTextuais || [];

                // Reranking textual
                if (ofertas.length > 0) {
                    const idsValidos = await refinarCandidatosBusca(termoBusca, ofertas);
                    if (idsValidos !== null) {
                        ofertas = ofertas.filter((of: any) => idsValidos.includes(of.id));
                    }
                }

                // Fallback semântico
                if (ofertas.length === 0) {
                    const vetorBusca = await gerarEmbedding(termoBusca);
                    if (vetorBusca) {
                        const { data: ofertasSemanticas, error: erroSem } = await supabase.rpc('buscar_ofertas_semantico', {
                            p_estado: contexto!.dadosConsumidor?.estado || 'PA',
                            p_query_embedding: vetorBusca,
                            p_match_threshold: 0.6,
                            p_limit: 15
                        });
                        if (!erroSem && ofertasSemanticas && ofertasSemanticas.length > 0) {
                            const idsValidos = await refinarCandidatosBusca(termoBusca, ofertasSemanticas);
                            if (idsValidos !== null) {
                                ofertas = ofertasSemanticas.filter((of: any) => idsValidos.includes(of.id));
                            } else {
                                ofertas = ofertasSemanticas.filter((of: any) => of.similarity >= 0.7);
                            }
                        }
                    }
                }

                if (ofertas.length === 0) {
                    itensNaoEncontrados.push(intencao.item);
                    continue;
                }

                // ── Classifica: Certeza (1 opção) vs. Ambiguidade (várias marcas/specs) ──
                // Agrupa por membro_core para detectar variantes da mesma categoria
                const gruposMarca = new Map<string, any>();
                for (const of_ of ofertas) {
                    const chave = (of_.produto_nome || '').toLowerCase();
                    if (!gruposMarca.has(chave)) gruposMarca.set(chave, of_);
                }
                const variantesUnicas = Array.from(gruposMarca.values());

                // Se o consumidor já especificou marca/spec OU disse que "qualquer" marca serve: é certeza
                const jaEspecificou = intencao.marca || intencao.especificacao || intencao.tamanho || intencao.qualquer_marca;
                
                if (variantesUnicas.length === 1 || jaEspecificou) {
                    itensAchados.push({ intencao, oferta: variantesUnicas[0] });
                } else if (variantesUnicas.length > 1) {
                    // Múltiplas variantes sem preferência expressa: ambiguidade
                    itensAmbiguos.push({ intencao, opcoes: variantesUnicas.slice(0, 3) });
                }
            }

            // ── Fase 2: Mensagem de resposta com Achados primeiro ───────────
            if (itensAchados.length === 0 && itensAmbiguos.length === 0) {
                await sendTextMessage(from, `😕 Poxa, não encontrei nenhum dos itens na sua região. Tente buscar outros produtos!`);
                return;
            }

            let msgBusca = '';

            // Bloco de certezas
            if (itensAchados.length > 0) {
                msgBusca += `🎯 *Encontrei ${itensAchados.length} item(s) na sua região!*\n\n`;
                for (const { oferta } of itensAchados) {
                    // Cross-sell: promoções da loja
                    const { data: promocoes } = await supabase
                        .from('ofertas_desconto').select('*')
                        .eq('loja_id', oferta.loja_id).eq('ativa', true)
                        .gte('validade', new Date().toISOString());
                    const promoText = (promocoes && promocoes.length > 0)
                        ? `\n🎁 Promo: ${Number(promocoes[0].percentual)}% OFF acima de R$ ${promocoes[0].valor_minimo}`
                        : '';
                    msgBusca += `🥇 *${oferta.produto_nome}*: R$ ${Number(oferta.preco_atual).toFixed(2).replace('.', ',')} / ${oferta.unidade}${promoText}\n\n`;
                }
            }

            // Itens não encontrados
            if (itensNaoEncontrados.length > 0) {
                msgBusca += `😕 *Não encontrei hoje:* ${itensNaoEncontrados.join(', ')}\n\n`;
            }

            // Bloco de ambiguidade (sempre no final)
            if (itensAmbiguos.length > 0) {
                msgBusca += `🤔 *Para completar sua lista, o que você prefere?*\n`;
                for (const { intencao, opcoes } of itensAmbiguos) {
                    const nomes = opcoes.map(o => `*${o.produto_nome}*`).join(' ou ');
                    msgBusca += `• Para o *${intencao.item}*, tem ${nomes}?\n`;
                }
            }

            // Botões de revelar apenas para os itens achados com certeza
            if (itensAchados.length > 0) {
                const top3 = itensAchados.slice(0, 3);
                const botoes = top3.map(({ oferta }, idx) => ({
                    id: `revelar_${oferta.id}_${oferta.loja_id}`,
                    title: `🔓 Revelar Op. ${idx + 1}`
                }));
                if (itensAmbiguos.length === 0) {
                    msgBusca += `👀 Deseja revelar a loja de qual opção? (Isso gasta créditos do lojista!)`;
                }
                await sendInteractiveButtons(from, msgBusca, botoes);
            } else {
                // Só há ambiguidade — envia texto sem botões de revelar
                await sendTextMessage(from, msgBusca.trim());
            }
            return;
        }

        await sendTextMessage(from, 'O que você está procurando hoje? Pode digitar ex: "Pizza", "Leite", etc.');
        return;
    }

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
            '  📷 Mandar uma *única foto* de todo o encarte ou cardápio (eu leio vários de uma vez!)\n' +
            '  🎙️ Enviar um *áudio* com os dados\n' +
            '  ✍️ *Digitar* o nome, preço e unidade'
        );
        return;
    }

    // ══════════════════════════════════════════════════════════
    // ESCUDO GLOBAL ANTI-SPAM DE MÍDIA
    // ══════════════════════════════════════════════════════════
    if (isMediaOnly && contexto && contexto.estado !== EstadosFluxo.IDLE && contexto.estado !== EstadosFluxo.AGUARDANDO_DADOS_PRODUTO && contexto.estado !== EstadosFluxo.AGUARDANDO_QUANTIDADE_EMBALAGEM) {
        logger.warn({ from, estado: contexto.estado }, '[Proteção] Mídia em estado não-esperado bloqueada');
        
        if (!temAvisoSpam(from)) {
            setAvisoSpam(from, 10);
            await sendTextMessage(from, '⚠️ Calma aí! Finalize a etapa pendente acima antes de enviar novas fotos ou áudios (clique no botão ou digite a opção solicitada).\n\n💡 *Dica:* Se você tem vários produtos, sabia que pode mandar uma *única foto* do cardápio todo de uma vez só? Eu leio tudo!');
        } else {
            // Renova o tempo de silêncio a cada mídia bloqueada para garantir 
            // que uma rajada longa no pg-boss não gere múltiplos avisos.
            setAvisoSpam(from, 10);
        }
        
        await renovarTTLContexto(from);
        return;
    }

    // ══════════════════════════════════════════════════════════
    // ARMADILHA 11: Handler de Embalagem Coletiva sem Quantidade
    // O lojista respondeu "24 latas" após a pergunta de quantidade
    // ══════════════════════════════════════════════════════════
    if (contexto?.estado === EstadosFluxo.AGUARDANDO_QUANTIDADE_EMBALAGEM && isTextOnly && userMessageText) {
        const produtoBase = contexto.dadosProduto;
        if (produtoBase?.nome && produtoBase?.preco) {
            const quantidadeTrimada = userMessageText.trim().substring(0, 30);
            const produtoEnriquecido = {
                nome: `${produtoBase.nome} (${quantidadeTrimada})`.substring(0, 250),
                preco: produtoBase.preco as number,
                unidade: (produtoBase.unidade || 'un') as string,
            };
            const ctxNormal = { ...contexto, estado: EstadosFluxo.AGUARDANDO_DADOS_PRODUTO };
            await salvarContexto(from, ctxNormal);
            await avançarParaSimilaresOuSalvar(from, loja, ctxNormal, produtoEnriquecido);
            return;
        }
        await limparContexto(from);
        await sendTextMessage(from, '😕 Não consegui recuperar o produto anterior. Por favor, envie novamente com a quantidade inclusa.');
        await enviarMenu(loja.nome, from);
        return;
    }

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

        if (acao === 'revisar') {
            await processarRevisaoPrecos(from, loja);
            return;
        }

        if (acao === 'cadastrar' || acao === 'revisar_renovar') {
            const msgInstrucao = acao === 'revisar_renovar'
                ? 'Ótimo! Vamos renovar seus preços. Você pode:\n\n📷 Mandar uma *única foto* de todo o encarte ou cardápio (eu atualizo vários de uma vez!)\n🎙️ Mandar um *áudio* rápido\n✍️ Ou *digitar* os novos valores (ex: Arroz 8,50)\n\nEstou aguardando!'
                : 'Ótimo! Para cadastrar ou atualizar, você pode:\n\n📷 Mandar uma *única foto* de todo o encarte ou cardápio (eu leio vários de uma vez!)\n🎙️ Mandar um *áudio*\n✍️ Ou *digitar* o nome e preço (ex: Feijão 10,00)\n\nO que deseja enviar?';

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

        // Detecta pares "número valor" na mensagem (ex: "1 8,50 2 15,00", "1- 8,50")
        // Suporta separadores estendidos: espaço, tab, traço, dois pontos, barras.
        const pairsRegex = /(\d+)[\s\-:=>*\/]+([\d]+[.,][\d]{1,2}|[\d]+)/g;
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
            const exemplo = lista.slice(0, 2).map((_: AlteracaoPlanejada, i: number) => `*${i + 1} - 0,00*`).join('\n');
            await sendTextMessage(from,
                `✍️ *Como atualizar preços:*\n` +
                `Digite o número do item e o novo preço. Pode mandar um embaixo do outro:\n\n` +
                `Exemplo:\n${exemplo}\n\n` +
                `_Para voltar ao menu, digite *cancelar*._`
            );
            await delay(300);
            await sendInteractiveButtons(from, 'Ou prefere sair agora?', [
                { id: 'btn_cancelar', title: '↩️ Voltar ao Menu' }
            ]);
            return;
        }
    }

    // ══════════════════════════════════════════════════════════
    // CENÁRIO 1/8/12: Estado IDLE (Inicia Ingestão Proativa)
    // ══════════════════════════════════════════════════════════
    if (!contexto || contexto.estado === EstadosFluxo.IDLE) {
        
        // 🎙️ Ingestão Proativa: Mídia em IDLE — 3 camadas de proteção de tokens
        if (isMediaOnly) {

            // ── CAMADA 1: Bloquear sticker e vídeo (nunca contêm preços) ──
            if (msg.type === 'sticker') {
                await sendTextMessage(from, '🎉 Recebi sua figurinha! Para cadastrar produtos, envie uma 📷 foto ou 🎙️ áudio com os dados.');
                return;
            }
            if (msg.type === 'video') {
                await sendTextMessage(from, '🎬 Recebi seu vídeo, mas não consigo extrair preços dele. Tire uma 📷 foto do encarte ou mande um 🎙️ áudio!');
                return;
            }

            // ── CAMADA 2: Filtro por tamanho (metadados da Meta, custo zero) ──
            const TAMANHO_MINIMO_BYTES = 15 * 1024; // 15 KB
            const mediaInfoRaw = (msg as any).image || (msg as any).audio || (msg as any).voice;
            const fileSizeRaw: number = mediaInfoRaw?.file_size ?? 0;
            // Só filtra se a Meta informou o tamanho (> 0) para evitar falsos positivos
            if (fileSizeRaw > 0 && fileSizeRaw < TAMANHO_MINIMO_BYTES) {
                const msgCamada2 = msg.type === 'image'
                    ? '📷 A foto chegou com qualidade baixa demais para eu ler os produtos. Pode tirar outra com boa iluminação?'
                    : '🎙️ O áudio chegou muito curto ou com qualidade baixa. Pode gravar novamente falando o nome e o preço?';
                await sendTextMessage(from, msgCamada2);
                return;
            }

            // ── CAMADA 3: Token Bucket — máx 10 mídias/hora por lojista ──
            const bucketExcedido = incrementarBucketMidia(from);
            if (bucketExcedido) {
                const ttlSecs = ttlBucketMidia(from);
                const mins = Math.floor(ttlSecs / 60);
                const secs = ttlSecs % 60;
                const tempoRestante = mins > 0
                    ? `${mins} minuto${mins > 1 ? 's' : ''}`
                    : `${secs} segundo${secs > 1 ? 's' : ''}`;
                const msgCamada3 = msg.type === 'image'
                    ? `⏳ Estou processando suas últimas fotos! Você poderá enviar mais em *${tempoRestante}*. Enquanto isso, pode *digitar* os produtos (Ex: Feijão 8,50).`
                    : `⏳ Estou processando seus últimos áudios! Você poderá enviar mais em *${tempoRestante}*. Enquanto isso, pode *digitar* os produtos (Ex: Feijão 8,50).`;
                logger.warn({ from, ttlSecs }, '[Camada3] Token bucket de mídia excedido');
                await sendTextMessage(from, msgCamada3);
                return;
            }

            // ── Passou pelas 3 camadas: adquirir LOCK para evitar paralelismo ──
            const lockKey = `lock:midia:${from}`;
            const obteuLock = await adquirirLock(lockKey, 120); // TTL 2 minutos
            if (!obteuLock) {
                const msgLock = msg.type === 'image'
                    ? '⏳ Ainda estou analisando sua última foto! 📷\n\n💡 *Dica:* Se você tem vários produtos, sabia que pode mandar uma *única foto* do cardápio todo de uma vez só? Eu leio tudo!'
                    : '⏳ Ainda estou ouvindo seu último áudio! Assim que terminar, pode mandar o próximo. 🎙️';
                await sendTextMessage(from, msgLock);
                return;
            }

            logger.info({ from }, '[Proativo] Lock adquirido. Iniciando extração...');
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
            
            const listaAtualizados: string[] = [];

            for (const alt of alteracoes) {
                if (alt.acao === 'remover') continue; // Pula itens excluídos pelo lojista

                if (alt.acao === 'novo_cadastro') {
                    await ingeriCatalogo(loja.id, { nome: alt.nome, preco: alt.precoFoto, unidade: alt.unidade }, 'foto');
                    inseridos++;
                } else if (alt.acao === 'preco_atualizado' && alt.produtoExistente) {
                    await atualizarPrecoLedger(loja.id, alt.produtoExistente.produto_nome, alt.precoFoto, alt.unidade || alt.produtoExistente.unidade);
                    atualizados++;
                    if (listaAtualizados.length < 10) {
                        const pAntigo = alt.produtoExistente.preco.toFixed(2).replace('.', ',');
                        const pNovo = alt.precoFoto.toFixed(2).replace('.', ',');
                        listaAtualizados.push(`• ${alt.produtoExistente.produto_nome}: R$ ${pAntigo} ➔ *R$ ${pNovo}*`);
                    }
                } else {
                    duplicatas++;
                }
            }
            
            let mensagemFinal = `🎉 *Importação Concluída!*\n`;
            if (inseridos > 0)   mensagemFinal += `\n🆕 *${inseridos} novo(s) cadastrado(s)*`;
            if (duplicatas > 0)  mensagemFinal += `\n⏭️ *${duplicatas} sem alteração (mesmo preço)*`;
            
            if (atualizados > 0) {
                mensagemFinal += `\n\n🔄 *${atualizados} preço(s) atualizado(s)*\n`;
                mensagemFinal += listaAtualizados.join('\n');
                if (atualizados > 10) {
                    mensagemFinal += `\n...e mais ${atualizados - 10} item(s).`;
                }
            }

            await sendTextMessage(from, mensagemFinal.trim());
            await limparContexto(from);
            await delay(400);
            await enviarMenu(loja.nome, from);
            return;
        }
        
        if (editar) {
            const lista = contexto.alteracoesPlanejadas ?? [];

            // UX Melhoria 3: Para listas curtas (≤3 itens), usar botões dinâmicos
            if (lista.length <= 3) {
                const botoes = lista.map((a: AlteracaoPlanejada, i: number) => ({
                    id: String(i + 1),
                    title: `${i + 1}. ${a.nome.substring(0, 18)}`,
                }));
                await salvarContexto(from, {
                    ...contexto,
                    estado: EstadosFluxo.AGUARDANDO_SELECAO_EDICAO,
                });
                await sendInteractiveButtons(from, '✏️ Qual produto deseja editar?', botoes);
            } else {
                await salvarContexto(from, {
                    ...contexto,
                    estado: EstadosFluxo.AGUARDANDO_SELECAO_EDICAO,
                });
                await sendTextMessage(from, `Digite o *NÚMERO* do item que deseja editar:\n(Exemplo: digite "2" para editar o segundo item)`);
            }
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
            const similares = itemEscolhido.similares;

            await salvarContexto(from, {
                ...contexto,
                estado: EstadosFluxo.AGUARDANDO_NOVO_PRECO_EDICAO,
                acao: indiceReal.toString() + '_desempate',
                similaresEncontrados: similares,
                dadosProduto: { nome: itemEscolhido.nome, preco: itemEscolhido.precoFoto, unidade: itemEscolhido.unidade },
                perguntaPendente: `Qual deles é o correspondente ao *${itemEscolhido.nome}*?`,
            });

            // Mesmo padrão de botões da Melhoria 1 — sem duplicidade de UX
            if (similares.length <= 2) {
                const botoes: Array<{ id: string; title: string }> = similares.map((s: any, i: number) => ({
                    id: String(i + 1),
                    title: `✅ ${s.produto_nome.substring(0, 20)}`,
                }));
                botoes.push({ id: '0', title: '🔄 Cadastrar como Novo' });

                const textoSimples = similares
                    .map((s: any, i: number) => `*${i + 1}* - ${s.produto_nome} (R$ ${s.preco.toFixed(2).replace('.', ',')} / ${s.unidade})`)
                    .join('\n');

                await sendTextMessage(from, `🔍 *Qual destes é o ${itemEscolhido.nome}?*\n\n${textoSimples}`);
                await delay(300);
                await sendInteractiveButtons(from, '↩️ Ou cancele para não alterar nada:', [
                    ...botoes,
                    { id: 'btn_cancelar', title: '❌ Cancelar' },
                ]);
            } else {
                let listaMsg = `⚠️ *Encontrei ${similares.length} opções no estoque*\nQual delas é o *${itemEscolhido.nome}*?\n\n`;
                similares.forEach((s: any, idx: number) => {
                    listaMsg += `───────────────\n`;
                    listaMsg += `*${idx + 1}* - ${s.produto_nome}\n`;
                    listaMsg += `📦 Estoque: R$ ${s.preco.toFixed(2).replace('.', ',')} / ${s.unidade}\n`;
                });
                listaMsg += `───────────────\n*0* - Nenhum (cadastrar como novo)`;

                await sendTextMessage(from, listaMsg);
                await delay(300);
                await sendInteractiveButtons(from, 'Ou desista sem alterar nada:', [
                    { id: 'btn_cancelar', title: '❌ Cancelar Operação' },
                ]);
            }
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

        // UX Melhoria 4: Mensagem de erro contextualizada com o produto em andamento
        const nomeProdutoContexto = contexto.dadosProduto?.nome
            ? ` (cadastro de *${contexto.dadosProduto.nome}*)` : '';
        await sendTextMessage(from, `Não entendi${nomeProdutoContexto}. Digite um número entre *0* e *${similares.length}*, ou toque em Cancelar.`);
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
// Funções transferidas para Skills (Fase 1: Modularização)
// ============================================================
// processarMidia        -> src/ai/skills/vision-processor.ts
// processLoteProdutos   -> src/ai/skills/vision-processor.ts
// buscarProdutosSimilares -> src/ai/skills/catalog-ledger.ts
// ingeriCatalogo        -> src/ai/skills/catalog-ledger.ts
// atualizarPrecoLedger  -> src/ai/skills/catalog-ledger.ts
// retirarEstoqueLedger  -> src/ai/skills/catalog-ledger.ts
// obterEstatisticas     -> src/ai/skills/store-services.ts
// criarOferta           -> src/ai/skills/store-services.ts
// buscarOfertasAtivas   -> src/ai/skills/store-services.ts
// processarRevisaoPrecos -> src/ai/skills/revisor.ts
// calcularSeloFrescor   -> src/ai/skills/revisor.ts
// formatarCartaoProduto -> src/ai/skills/vision-processor.ts