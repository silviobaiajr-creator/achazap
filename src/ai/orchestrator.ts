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
import { handleOnboarding } from './agents/onboarding-agent.js';
import { handleInventory, processarDadosProduto, avançarParaSimilaresOuSalvar } from './agents/inventory-agent.js';
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
        // Se estivermos na revisão de preços, bloqueia o NLP para mensagens que são majoritariamente números,
        // para evitar que erros de digitação como "1 26,O0" sejam classificados como fuga.
        if (contexto.estado === EstadosFluxo.AGUARDANDO_SELECAO_REVISAO) {
            const numDigits = (userText.match(/\d/g) || []).length;
            if (numDigits >= 2) return false; // Provavelmente é tentativa de preço
        }

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
        const foiConsumido = await handleOnboarding(msg, from, loja, contexto, userText, buttonId, (novaLoja) => {
            loja = novaLoja;
        });

        if (foiConsumido) {
            return;
        }

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
    if (isMediaOnly && contexto && 
        contexto.estado !== EstadosFluxo.IDLE && 
        contexto.estado !== EstadosFluxo.AGUARDANDO_DADOS_PRODUTO && 
        contexto.estado !== EstadosFluxo.AGUARDANDO_QUANTIDADE_EMBALAGEM &&
        contexto.estado !== EstadosFluxo.AGUARDANDO_SELECAO_REVISAO) {
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
        
        // Proteção contra mídias durante a revisão (Cenário 8)
        const lista: AlteracaoPlanejada[] = contexto.alteracoesPlanejadas ?? [];

        if (!isTextOnly) {
            let msgErro = '🛑 *Revisão em andamento:* Durante a revisão, por favor **digite** o número e o novo preço.\n\n' +
                          'Áudios e fotos são ideais para o Menu Inicial. Digite *0* se quiser cancelar.\n\n' +
                          '📋 *Ainda pendentes:*\n';
            
            lista.forEach((item: AlteracaoPlanejada, i: number) => {
                const selo = calcularSeloFrescor(item.dataReferencia);
                msgErro += `*${i + 1}. ${item.nome}* — R$ ${item.precoFoto.toFixed(2).replace('.', ',')} / ${item.unidade} ${selo}\n`;
            });

            await sendTextMessage(from, msgErro);
            return;
        }

        // Escape explícito com '0' (Cenário 2)
        if (userText.trim() === '0') {
            await sendTextMessage(from, 'Revisão cancelada.');
            await limparContexto(from);
            await delay(400);
            await enviarMenu(loja.nome, from);
            return;
        }

        // Regex blindada: Exige que o preço termine ou tenha separadores válidos, bloqueando letras grudadas (ex: 26,O0)
        // O (?=\s|$) garante que depois do número venha um espaço ou o fim da linha.
        // Regex blindada: aceita separadores variados e prefixo R$ opcional.
        // (?=\s|$|\n) garante que o preço não seja seguido de letras grudadas (ex: 26,O0).
        // Regex simplificada para capturar o bloco de preço completo (incluindo milhar)
        const pairsRegex = /(?:^|\s)(\d+)[\s\-:=>*\/]+((?:R\$\s*)?[\d.,]+)(?=\s|$|\n)/gi;
        const pares: { idx: number; preco: number }[] = [];
        let match: RegExpExecArray | null;

        while ((match = pairsRegex.exec(userText)) !== null) {
            const idx   = parseInt(match[1]!, 10);
            
            // Parser Inteligente:
            // 1. Remove R$ e espaços
            // 2. Se houver vírgula, assume que é o decimal e remove todos os pontos (milhar)
            let rawPreco = match[2]!.replace(/[R$\s]/gi, '');
            if (rawPreco.includes(',')) {
                rawPreco = rawPreco.replace(/\./g, '').replace(',', '.');
            }
            
            const preco = Number(rawPreco);
            
            if (!isNaN(idx) && !isNaN(preco) && idx >= 1 && idx <= lista.length && preco > 0) {
                // Trava de Sanidade (Cenário 9)
                if (preco > 5000) {
                    await sendTextMessage(from, `⚠️ O valor de R$ ${preco.toFixed(2).replace('.', ',')} para o item ${idx} parece alto demais. Por segurança, digite novamente ou verifique se faltou a vírgula.`);
                    return;
                }
                pares.push({ idx, preco });
            }
        }

        if (pares.length > 0) {
            // Cenário 13: Detecção de Índices Repetidos
            const idsUnicos = new Set(pares.map(p => p.idx));
            if (idsUnicos.size < pares.length) {
                await sendTextMessage(from, `⚠️ *Atenção:* Você lançou preços diferentes para o mesmo item. Por favor, corrija e envie novamente.\n\n_Ex: Se o item 1 mudou para R$ 10,00, mande apenas "1 10,00"._`);
                return;
            }

            const resultados: string[] = [];
            for (const par of pares) {
                const item = lista[par.idx - 1]!;
                await atualizarPrecoLedger(loja.id, item.nome, par.preco, item.unidade);
                resultados.push(`✅ *${par.idx}. ${item.nome}* → R$ ${par.preco.toFixed(2).replace('.', ',')} / ${item.unidade}`);
                item.acao = 'sem_alteracao';
                item.precoFoto = par.preco;
            }

            const atualizadosIds = new Set(pares.map(p => p.idx));
            const pendentes = lista.filter((_: AlteracaoPlanejada, i: number) => !atualizadosIds.has(i + 1));
            const totalInicial = contexto.totalItensRevisao || lista.length;
            const pendentesRestantes = pendentes.length;
            const totalConcluido = totalInicial - pendentesRestantes;
            
            const feedbackMsg = `✅ *Progresso:* ${totalConcluido} de ${totalInicial} item(s) revisados.\n` + resultados.join('\n');

            if (pendentes.length === 0) {
                await sendTextMessage(from, feedbackMsg + '\n\n🎉 *Lote concluído com sucesso!* Verificando se ainda há itens pendentes...');
                await delay(800);
                // Cenário 15: Continuidade automática para grandes estoques
                await processarRevisaoPrecos(from, loja);
            } else {
                let novaLista = `${feedbackMsg}\n\n📋 *Ainda pendentes:*\n`;
                pendentes.forEach((item: AlteracaoPlanejada) => {
                    const idxOriginal = lista.indexOf(item) + 1;
                    const selo = calcularSeloFrescor(item.dataReferencia);
                    novaLista += `*${idxOriginal}. ${item.nome}* — R$ ${item.precoFoto.toFixed(2).replace('.', ',')} / ${item.unidade} ${selo}\n`;
                });
                novaLista += `\n✏️ _Ex: *${pendentes.map((_: AlteracaoPlanejada, i: number) => `${lista.indexOf(pendentes[i]!) + 1} 0,00`).slice(0, 2).join(' ')}_`;
                await salvarContexto(from, {
                    ...contexto,
                    alteracoesPlanejadas: pendentes,
                    totalItensRevisao:   totalInicial,
                });
                await sendTextMessage(from, novaLista);
            }
            return;
        }

        // Se chegou aqui, isTextOnly é true, mas não encontrou pares válidos. (Cenários 5, 6, 7)
        if (userText.trim().length > 0) {
            const exemplo = lista.slice(0, 2).map((_: AlteracaoPlanejada, i: number) => `*${lista.indexOf(lista[i]!) + 1} 15,90*`).join('\n');
            await sendTextMessage(from,
                `🤔 Não consegui entender os valores. Lembre-se de colocar o **número do item** e depois o **preço**.\n\n` +
                `Exemplo correto:\n${exemplo}\n\n` +
                `🛑 _Digite 0 se quiser cancelar a revisão._`
            );
            return;
        }

        return; 
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

    // ── InventoryAgent: delega estados de inventário ──────────────────────────
    if (await handleInventory(msg, from, loja, contexto, userMessageText, buttonId, isInteractive, isTextOnly, isMediaOnly, processMessage)) {
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
    logger.warn({ from, estado: contexto?.estado, userText }, '[processMessage] Fallback Zero-Silence acionado. Variaveis de depuracao ativadas.');
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