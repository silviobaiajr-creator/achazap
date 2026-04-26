/**
 * src/ai/agents/inventory-agent.ts
 * Agente de Inventário — extraído do orchestrator.ts na Fase 2.
 * Responsável por: cadastro de produtos, similares, edição de lote e confirmações.
 */
import { type WhatsAppMessage, sendTextMessage, sendInteractiveButtons, sendListMessage } from '../../lib/whatsapp.js';
import { limparContexto, salvarContexto, renovarTTLContexto } from '../../lib/redis-cloud.js';
import { ai, GEMINI_MODEL } from '../../lib/gemini.js';
import { logger, logTokens } from '../../lib/logger.js';
import { parseSafe, NLPEscolhaSchema, ProdutoExtraidoSchema, MultiProdutosTextoSchema } from '../schemas.js';
import { EstadosFluxo, type ContextoSessao, type DadosProduto, type AlteracaoPlanejada } from '../types.js';
import { buscarProdutosSimilares, buscarSimilaresSemanticoRaw, ingeriCatalogo, atualizarPrecoLedger, retirarEstoqueLedger } from '../skills/catalog-ledger.js';
import { rotearIntencaoGlobal, batchRefinarCandidatosBusca } from '../skills/intent-detector.js';
import { processarMidia, processLoteProdutos, formatarCartaoProduto } from '../skills/vision-processor.js';
import { enviarMenu, executarFuga } from '../shared.js';
import { calcularSeloFrescor } from '../skills/revisor.js';

const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

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
    if (contexto.estado === EstadosFluxo.IDLE && (similares?.length ?? 0) === 0) {
        await processarLoteProdutos(from, loja, [produto], contexto);
        return;
    }

    if ((similares?.length ?? 0) > 0) {
        await salvarContexto(from, {
            ...contexto,
            estado: EstadosFluxo.AGUARDANDO_ACAO_SIMILARES,
            dadosProduto: produto,
            similaresEncontrados: similares,
            acao: 'cadastrar',
            retries: 0,
        });

        // UX Melhoria 1: Para 1 ou 2 similares, usar botões interativos
        if ((similares?.length ?? 0) <= 2) {
            const botoes: Array<{ id: string; title: string }> = similares.map((s, i) => ({
                id: String(i + 1),
                title: `✅ ${s.produto_nome.substring(0, 20)}`,
            }));
            botoes.push({ id: '0', title: '🔄 Cadastrar como Novo' });

            const textoSimples = similares
                .map((s, i) => {
                    const selo = calcularSeloFrescor((s as any).atualizado_em);
                    return `*${i + 1}* - ${s.produto_nome} (R$ ${s.preco.toFixed(2).replace('.', ',')} / ${s.unidade})\n⏱️ ${selo}`;
                })
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
                const selo = calcularSeloFrescor((s as any).atualizado_em);
                listaMsg += `───────────────\n`;
                listaMsg += `*${i + 1}* - ${s.produto_nome}\n`;
                listaMsg += `💰 R$ ${s.preco.toFixed(2).replace('.', ',')} / ${s.unidade}\n`;
                listaMsg += `⏱️ ${selo}\n`;
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
// ─── Estados gerenciados por este agente ────────────────────────────────────
const INVENTORY_STATES = new Set<string>([
    EstadosFluxo.AGUARDANDO_DADOS_PRODUTO,
    EstadosFluxo.AGUARDANDO_ACAO_SIMILARES,
    EstadosFluxo.AGUARDANDO_ACAO_PRODUTO_SELECIONADO,
    EstadosFluxo.AGUARDANDO_CONFIRMACAO_NOME,
    EstadosFluxo.AGUARDANDO_QUANTIDADE_EMBALAGEM,
    EstadosFluxo.AGUARDANDO_CONFIRMACAO_ALTERACOES,
    EstadosFluxo.AGUARDANDO_SELECAO_EDICAO,
    EstadosFluxo.AGUARDANDO_NOVO_PRECO_EDICAO,
    EstadosFluxo.AGUARDANDO_NOVO_NOME_EDICAO,
]);

export { processarDadosProduto, avançarParaSimilaresOuSalvar };

// ─── Ponto de entrada do agente ─────────────────────────────────────────────
export async function handleInventory(
    msg: WhatsAppMessage,
    from: string,
    loja: any,
    contexto: ContextoSessao | null,
    userMessageText: string,
    buttonId: string,
    isInteractive: boolean,
    isTextOnly: boolean,
    isMediaOnly: boolean,
    reprocessFn: (msg: WhatsAppMessage) => Promise<void>,
): Promise<boolean> {
    if (!loja || !contexto) return false;
    if (!INVENTORY_STATES.has(contexto.estado)) return false;

    // ══════════════════════════════════════════════════════════
    // ARMADILHA 11: Handler de Embalagem Coletiva sem Quantidade
    // O lojista respondeu "24 latas" após a pergunta de quantidade
    // ══════════════════════════════════════════════════════════
    if (contexto.estado === EstadosFluxo.AGUARDANDO_QUANTIDADE_EMBALAGEM && isTextOnly && userMessageText) {
        const produtoBase = contexto.dadosProduto;
        if (produtoBase?.nome && produtoBase?.preco) {
            const quantidadeTrimada = userMessageText.trim().substring(0, 30);
            const produtoEnriquecido = {
                nome: `${produtoBase.nome} (${quantidadeTrimada})`.substring(0, 250),
                preco: produtoBase.preco as number,
                unidade: (produtoBase.unidade || 'un') as string,
            };
            const ctxNormal = { ...contexto, estado: EstadosFluxo.AGUARDANDO_DADOS_PRODUTO, dadosProduto: produtoEnriquecido };
            await salvarContexto(from, ctxNormal);
            await avançarParaSimilaresOuSalvar(from, loja, ctxNormal, produtoEnriquecido);
            return true;
        }
        await limparContexto(from);
        await sendTextMessage(from, '😕 Não consegui recuperar o produto anterior. Por favor, envie novamente com a quantidade inclusa.');
        await delay(300);
        await enviarMenu(loja.id, from); // Usando loja.id ou loja.nome? enviarMenu usa nome.
        return true;
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
                return true;
            }
            
            await avançarParaSimilaresOuSalvar(from, loja, contexto, p);
            return true;
        }

        if (recusou) {
            await salvarContexto(from, { ...contexto, estado: EstadosFluxo.AGUARDANDO_DADOS_PRODUTO, perguntaPendente: 'Qual o Nome, Preço e Unidade corretos?' });
            await sendTextMessage(from, 'Entendi! Por favor, digite o *NOME*, *PREÇO* e *UNIDADE* corretos do produto novamente:');
            return true;
        }

        // Resposta inválida - repetir botões
        await sendInteractiveButtons(from, `🤔 Fiquei na dúvida... Você quis dizer *${contexto.dadosProduto?.nome}*?`, [
            { id: 'btn_sugestao_sim', title: 'Sim, isso mesmo' },
            { id: 'btn_sugestao_nao', title: 'Não, digitar denovo' }
        ]);
        return true;
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
                return true;
            }
            
            if (alteracoes.length === 0) {
                await sendTextMessage(from, 'Nada a alterar. Tente novamente.');
                await limparContexto(from);
                await enviarMenu(loja.nome, from);
                return true;
            }
            
            let inseridos = 0;
            let atualizados = 0;
            let duplicatas = 0;
            
            const listaAtualizados: string[] = [];

            for (const alt of alteracoes) {
                if (alt.acao === 'remover') continue; 
                const fonteReal = alt.fonte || 'manual';

                if (alt.acao === 'novo_cadastro') {
                    await ingeriCatalogo(loja.id, { nome: alt.nome, preco: alt.precoFoto, unidade: alt.unidade }, fonteReal);
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
            return true;
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
            } else if (lista.length <= 10) {
                const rows = lista.map((a: AlteracaoPlanejada, i: number) => {
                    const desc = a.acao === 'ambiguo' ? '⚠️ Ambíguo' : `R$ ${a.precoFoto.toFixed(2).replace('.', ',')}`;
                    return {
                        id: String(i + 1),
                        title: `${i + 1}. ${a.nome.substring(0, 20)}`,
                        description: desc.substring(0, 70),
                    };
                });
                await salvarContexto(from, {
                    ...contexto,
                    estado: EstadosFluxo.AGUARDANDO_SELECAO_EDICAO,
                });
                await sendListMessage(from, '✏️ Qual produto deseja editar?', 'Escolher Produto', [
                    { title: 'Produtos na Lista', rows }
                ]);
            } else {
                await salvarContexto(from, {
                    ...contexto,
                    estado: EstadosFluxo.AGUARDANDO_SELECAO_EDICAO,
                });
                await sendTextMessage(from, `Digite o *NÚMERO* do item que deseja editar:\n(Exemplo: digite "2" para editar o segundo item)`);
            }
            return true;
        }

        
        if (cancelou) {
            await sendTextMessage(from, '❌ Alterações canceladas. Nada foi salvo.');
            await limparContexto(from);
            await delay(400);
            await enviarMenu(loja.nome, from);
            return true;
        }
        
        await sendInteractiveButtons(from, `⚡ Confirma as alterações acima?`, [
            { id: 'confirmar_alteracoes_sim', title: '✅ Confirmar Todos' },
            { id: 'editar_item_lista', title: '✏️ Editar um Item' },
            { id: 'confirmar_alteracoes_nao', title: '❌ Cancelar Tudo' },
        ]);
        return true;
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
                return true;
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
                        return true;
                    }

                    if (Number.isInteger(nlp.escolha) && nlp.escolha >= 1 && nlp.escolha <= lista.length) {
                        // Recomeça o processamento com o número injetado
                        await reprocessFn({ ...msg, text: { body: String(nlp.escolha) } });
                        return true;
                    }
                } catch (e) {
                    logger.error({ e }, '[NLP Selecao Edicao] Erro fallback');
                }
            }
            
            await sendTextMessage(from, `⚠️ Não entendi qual item você quer editar. Digite o número entre *1* e *${lista.length}* ou o nome do produto.`);
            return true;
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
                    .map((s: any, i: number) => {
                        const selo = calcularSeloFrescor(s.atualizado_em);
                        return `*${i + 1}* - ${s.produto_nome} (R$ ${s.preco.toFixed(2).replace('.', ',')} / ${s.unidade})\n⏱️ ${selo}`;
                    })
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
                    const selo = calcularSeloFrescor(s.atualizado_em);
                    listaMsg += `───────────────\n`;
                    listaMsg += `*${idx + 1}* - ${s.produto_nome}\n`;
                    listaMsg += `💰 R$ ${s.preco.toFixed(2).replace('.', ',')} / ${s.unidade}\n`;
                    listaMsg += `⏱️ ${selo}\n`;
                });
                listaMsg += `───────────────\n*0* - Nenhum (cadastrar como novo)`;

                await sendTextMessage(from, listaMsg);
                await delay(300);
                await sendInteractiveButtons(from, 'Ou desista sem alterar nada:', [
                    { id: 'btn_cancelar', title: '❌ Cancelar Operação' },
                ]);
            }
            return true;
        }
        
        // NOVO FLOW: Menu de Edição de Item em vez de pedir preço direto
        await salvarContexto(from, {
            ...contexto,
            estado: EstadosFluxo.AGUARDANDO_NOVO_PRECO_EDICAO, // Reutilizamos esse estado ou um novo? Melhor um novo.
            acao: indiceReal.toString(),
        });

        await sendInteractiveButtons(from, 
            `Item: *${itemEscolhido.nome}*\nPreço atual: R$ ${(itemEscolhido.precoFoto ?? 0).toFixed(2).replace('.', ',')}\n\nO que deseja alterar?`,
            [
                { id: `edit_nome_${indiceReal}`, title: '✏️ Nome' },
                { id: `edit_preco_${indiceReal}`, title: '💰 Preço' },
                { id: `edit_excluir_${indiceReal}`, title: '❌ Excluir' }
            ]
        );
        return true;
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
            return true;
        }

        if (buttonId.startsWith('edit_preco_')) {
            await sendTextMessage(from, `Qual o novo preço para *${item.nome}*? (Preço na lista: R$ ${item.precoFoto.toFixed(2).replace('.', ',')})`);
            return true; // Espera o texto do preço no próximo ciclo (mesmo estado)
        }

        if (buttonId.startsWith('edit_excluir_')) {
            item.acao = 'remover';
            await sendTextMessage(from, `🚫 *${item.nome}* será removido da lista final.`);
            await delay(400);
            await processLoteProdutos(from, loja, lista);
            return true;
        }
    }

    if (contexto.estado === EstadosFluxo.AGUARDANDO_NOVO_NOME_EDICAO) {
        const indiceReal = parseInt(contexto.acao ?? '0', 10);
        const lista = contexto.alteracoesPlanejadas ?? [];
        const item = lista[indiceReal];
        const novoNome = userMessageText.trim();

        if (novoNome.length < 3) {
            await sendTextMessage(from, '⚠️ Nome muito curto. Por favor, digite o nome completo do produto.');
            return true;
        }

        const nomeAntigo = item.nome;
        item.nome = novoNome;
        
        await sendTextMessage(from, `✅ Nome alterado de *${nomeAntigo}* para *${novoNome}*!`);
        await delay(400);
        await processLoteProdutos(from, loja, lista);
        return true;
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
                    return true;
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
                            return true;
                        }

                        if (Number.isInteger(nlp.escolha) && nlp.escolha >= 0 && nlp.escolha <= (item.similares?.length ?? 0)) {
                            await reprocessFn({ ...msg, text: { body: String(nlp.escolha) } });
                            return true;
                        }
                    } catch (e) {
                         logger.error({ e }, '[NLP Desempate Edicao] Erro fallback');
                    }
                }

                await sendTextMessage(from, `⚠️ Escolha inválida. Digite um número entre *0* e *${item.similares?.length}* ou o nome da opção desejada.`);
                return true;
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
            return true;
        }
        
        // Modo normal: editar preço ou excluir
        const indiceReal = parseInt(contexto.acao ?? '0', 10);
        
        const precoLimpo = userMessageText.replace(',', '.').replace(/[^\d.]/g, '');
        const novoPreco = parseFloat(precoLimpo);
        
        if (isNaN(novoPreco) || novoPreco < 0) {
            await sendTextMessage(from, '⚠️ Valor inválido. Digite um número como "9,50", ou "0" para excluir o item.');
            return true;
        }
        
        let mensagemFeedback = '';
        
        if (novoPreco === 0) {
            lista.splice(indiceReal, 1);
            
            if (lista.length === 0) {
                await sendTextMessage(from, '🗑️ Você removeu todos os itens da lista. A operação foi cancelada.');
                await limparContexto(from);
                await delay(400);
                await enviarMenu(loja.nome, from);
                return true;
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
        return true;
    }



    // ══════════════════════════════════════════════════════════
    // CENÁRIO 2/3/10/11: Aguardando dados do produto
    // ══════════════════════════════════════════════════════════
    if (contexto.estado === EstadosFluxo.AGUARDANDO_DADOS_PRODUTO) {

        if (!userMessageText.trim() && isMediaOnly) {
            // Sprint 11: Upload de imagem/áudio para extração
            await processarMidia(msg, from, loja, contexto);
            return true;
        }

        if (msg.type === 'interactive') {
            await sendTextMessage(from, 'Por favor, *digite* o nome, preço e unidade do produto. Ex: Feijão Preto 15,00 kg');
            return true;
        }

        await processarDadosProduto(from, loja, userMessageText, contexto);
        return true;
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
                return true;
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
                return true;
            }


            // Opção 1..N: produto selecionado
            const prod     = similares[opcaoNum - 1];
            const novoPreco = contexto.dadosProduto?.preco;

            if (novoPreco === null || novoPreco === undefined) {
                await sendTextMessage(from, 'Não tenho o novo preço para atualizar. Por favor, comece novamente.');
                await limparContexto(from);
                await delay(300);
                await enviarMenu(loja.nome, from);
                return true;
            }

            // Sprint 3 #5: verificar se preço é igual ao atual (atualização inútil)
            if (novoPreco === prod.preco) {
                await sendTextMessage(from, `ℹ️ O produto *${prod.produto_nome}* já está registrado com o valor de R$ ${prod.preco}. Nenhuma alteração necessária!`);
                await limparContexto(from);
                await delay(300);
                await enviarMenu(loja.nome, from);
                return true;
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
            return true;
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
            await reprocessFn({ ...msg, text: { body: String(mapeado) } });
            return true;
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
                    return true;
                }
                
                if (Number.isInteger(nlp.escolha) && nlp.escolha >= 0 && nlp.escolha <= similares.length) {
                    await reprocessFn({ ...msg, text: { body: String(nlp.escolha) } });
                    return true;
                }
            } catch { /* ignora erro NLP, vai cair no fallback padrão abaixo */ }
        }

        // UX Melhoria 4: Mensagem de erro contextualizada com o produto em andamento
        const nomeProdutoContexto = contexto.dadosProduto?.nome
            ? ` (cadastro de *${contexto.dadosProduto.nome}*)` : '';
        await sendTextMessage(from, `Não entendi${nomeProdutoContexto}. Digite um número entre *0* e *${similares.length}*, ou toque em Cancelar.`);
        await renovarTTLContexto(from);
        return true;

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
                return true;
            }

            if (buttonId === 'acao_atualizar' && (produto.preco === null || produto.preco === undefined)) {
                logger.error({ from, produto }, '[acao_atualizar] Preço ausente no contexto');
                await limparContexto(from);
                await sendTextMessage(from, '⏳ Sessão expirada. Por favor, comece novamente enviando o produto com o preço.');
                await delay(300);
                await enviarMenu(loja.nome, from);
                return true;
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
            return true;
        }

        // Sprint 12 #3: clique de ação diferente do esperado — cross-state contamination
        if (isInteractive && !buttonId.startsWith('menu_') && buttonId !== 'acao_atualizar' && buttonId !== 'acao_retirar') {
            await sendTextMessage(from, '⏳ Sessão expirada ou comando inválido. Vamos recomeçar!');
            await limparContexto(from);
            await delay(300);
            await enviarMenu(loja.nome, from);
            return true;
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
        return true;
    }
    return true;
}
