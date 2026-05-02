/**
 * src/ai/agents/consumer-agent.ts
 * Agente responsável pelo fluxo do Consumidor:
 * - Busca semântica e textual de produtos
 * - Revelação de loja com débito de crédito
 */

import {
    sendTextMessage,
    sendInteractiveButtons,
    type WhatsAppMessage,
} from '../../lib/whatsapp.js';
import { supabaseAdmin as supabase } from '../../lib/supabase.js';
import { EstadosFluxo, ContextoSessao } from '../types.js';
import { refinarCandidatosBusca, extrairListaCompras } from '../skills/intent-detector.js';
import { gerarEmbedding } from '../skills/catalog-ledger.js';

const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

export async function handleConsumer(
    msg: WhatsAppMessage,
    from: string,
    loja: any,
    contexto: ContextoSessao | null,
    userText: string,
    buttonId: string,
    isTextOnly: boolean,
): Promise<boolean> {

    // Apenas consumidores sem loja
    const isUsuarioConsumidor = !loja && contexto?.estado === EstadosFluxo.CONSUMIDOR_IDLE;
    if (!isUsuarioConsumidor) return false;

    // ── Revelação de Loja ─────────────────────────────────────────────────────
    if (buttonId.startsWith('revelar_')) {
        const [, idOferta, idLoja] = buttonId.split('_');

        const { data: usuarioData } = await supabase.from('usuarios')
            .select('id')
            .eq('whatsapp', from.startsWith('+') ? from : '+' + from)
            .maybeSingle();
        const usuarioId = usuarioData?.id || '00000000-0000-0000-0000-000000000000';

        const { data } = await supabase.from('lojas').select('whatsapp, nome').eq('id', idLoja).single();

        if (data) {
            await supabase.from('cliques_consumidos').insert({
                loja_id: idLoja,
                usuario_id: usuarioId,
                produto_ref: 'revelacao',
                link_token: 'unlock_' + Math.random().toString(36).substring(7),
                debitado: true,
            });

            const { error: rpcErr } = await supabase.rpc('decrementar_saldo', { p_loja_id: idLoja, p_qtd: 1 });
            if (rpcErr) {
                const { data: l } = await supabase.from('lojas').select('saldo_cliques').eq('id', idLoja).single();
                if (l) await supabase.from('lojas').update({ saldo_cliques: Math.max(0, l.saldo_cliques - 1) }).eq('id', idLoja);
            }

            await sendTextMessage(from,
                `🎉 *Nome Revelado!*\n\nA opção escolhida foi a loja *${data.nome}*.\n\n📲 Pode mandar o Zap pra eles: ${data.whatsapp}\n\nDica: Diga que veio pelo AchaZap!`
            );
        } else {
            await sendTextMessage(from, 'Loja indisponível.');
        }
        return true;
    }

    // ── Busca de Produtos ─────────────────────────────────────────────────────
    if (isTextOnly && userText) {
        const txtLimpo = userText.trim().toLowerCase();
        const greetings = ['oi', 'olá', 'ola', 'oie', 'bom dia', 'boa tarde', 'boa noite', 'tudo bem'];
        if (greetings.includes(txtLimpo) || txtLimpo.length < 3) {
            await sendTextMessage(from, 'Olá! O que você quer comprar hoje? Pode digitar ex: "Pizza", "Leite", etc.');
            return true;
        }

        const listaIntencao = await extrairListaCompras(userText);
        const nomesItens = listaIntencao.map(i => i.item).join(', ');

        await sendTextMessage(from, `🔍 Procurando *${nomesItens}* mais baratos e próximos de você em ${contexto!.dadosConsumidor?.bairro}...`);
        await delay(1500);

        const itensAchados: Array<{ intencao: typeof listaIntencao[0]; oferta: any }> = [];
        const itensAmbiguos: Array<{ intencao: typeof listaIntencao[0]; opcoes: any[] }> = [];
        const itensNaoEncontrados: string[] = [];

        for (const intencao of listaIntencao) {
            const termoBusca = [intencao.item, intencao.marca, intencao.especificacao, intencao.tamanho]
                .filter(Boolean).join(' ').trim();

            const { data: ofertasTextuais } = await supabase.rpc('buscar_ofertas', {
                p_cidade: contexto!.dadosConsumidor?.cidade,
                p_bairro: contexto!.dadosConsumidor?.bairro,
                p_estado: contexto!.dadosConsumidor?.estado || 'PA',
                p_query: termoBusca,
            });

            let ofertas = ofertasTextuais || [];

            if (ofertas.length > 0) {
                const idsValidos = await refinarCandidatosBusca(termoBusca, ofertas);
                if (idsValidos !== null) ofertas = ofertas.filter((of: any) => idsValidos.includes(of.id));
            }

            if (ofertas.length === 0) {
                const vetorBusca = await gerarEmbedding(termoBusca);
                if (vetorBusca) {
                    const { data: ofertasSemanticas, error: erroSem } = await supabase.rpc('buscar_ofertas_semantico', {
                        p_estado: contexto!.dadosConsumidor?.estado || 'PA',
                        p_query_embedding: vetorBusca,
                        p_match_threshold: 0.6,
                        p_limit: 15,
                    });
                    if (!erroSem && ofertasSemanticas && ofertasSemanticas.length > 0) {
                        const idsValidos = await refinarCandidatosBusca(termoBusca, ofertasSemanticas);
                        ofertas = idsValidos !== null
                            ? ofertasSemanticas.filter((of: any) => idsValidos.includes(of.id))
                            : ofertasSemanticas.filter((of: any) => of.similarity >= 0.7);
                    }
                }
            }

            if (ofertas.length === 0) { itensNaoEncontrados.push(intencao.item); continue; }

            const gruposMarca = new Map<string, any>();
            for (const of_ of ofertas) {
                const chave = (of_.produto_nome || '').toLowerCase();
                if (!gruposMarca.has(chave)) gruposMarca.set(chave, of_);
            }
            const variantesUnicas = Array.from(gruposMarca.values());
            const jaEspecificou = intencao.marca || intencao.especificacao || intencao.tamanho || intencao.qualquer_marca;

            if (variantesUnicas.length === 1 || jaEspecificou) {
                itensAchados.push({ intencao, oferta: variantesUnicas[0] });
            } else {
                itensAmbiguos.push({ intencao, opcoes: variantesUnicas.slice(0, 3) });
            }
        }

        if (itensAchados.length === 0 && itensAmbiguos.length === 0) {
            await sendTextMessage(from, '😕 Poxa, não encontrei nenhum dos itens na sua região. Tente buscar outros produtos!');
            return true;
        }

        let msgBusca = '';

        if (itensAchados.length > 0) {
            msgBusca += `🎯 *Encontrei ${itensAchados.length} item(s) na sua região!*\n\n`;
            for (const { oferta } of itensAchados) {
                // Destaques Visuais do Modelo de Negócios
                const isPremium = oferta.plano === 'premium';
                const isRelampago = oferta.oferta_expira_em && new Date(oferta.oferta_expira_em) > new Date();
                
                const seloPremium = isPremium ? ' ⭐(Loja Premium)' : '';
                const seloRelampago = isRelampago ? ' ⚡(OFERTA RELÂMPAGO SÓ HOJE)' : '';

                // Extração de Valor dos Metadados (em vez de focar só no menor preço)
                let detalhesValor = '';
                if (oferta.metadados) {
                    const meta = oferta.metadados;
                    const extras = [];
                    if (meta.marca) extras.push(`Marca: ${meta.marca}`);
                    if (meta.especificacao) extras.push(`Detalhes: ${meta.especificacao}`);
                    // Adicionar outros trunfos de venda se existirem no JSON (ex: garantia, pronta entrega)
                    if (meta.garantia) extras.push(`🛡️ Garantia: ${meta.garantia}`);
                    if (meta.condicao) extras.push(`✨ Condição: ${meta.condicao}`);
                    if (extras.length > 0) {
                        detalhesValor = `\n   ↳ _${extras.join(' | ')}_`;
                    }
                }

                // Ofertas Globais da Loja
                const { data: promocoes } = await supabase
                    .from('ofertas_desconto').select('*')
                    .eq('loja_id', oferta.loja_id).eq('ativa', true)
                    .gte('validade', new Date().toISOString());
                const promoText = (promocoes && promocoes.length > 0)
                    ? `\n   🎁 Cupom da Loja: ${Number(promocoes[0].percentual)}% OFF acima de R$ ${promocoes[0].valor_minimo}`
                    : '';

                msgBusca += `🥇 *${oferta.produto_nome}*${seloPremium}${seloRelampago}\n   💰 Por R$ ${Number(oferta.preco_atual).toFixed(2).replace('.', ',')} / ${oferta.unidade}${detalhesValor}${promoText}\n\n`;
            }
        }

        if (itensNaoEncontrados.length > 0) msgBusca += `😕 *Não encontrei hoje:* ${itensNaoEncontrados.join(', ')}\n\n`;

        if (itensAmbiguos.length > 0) {
            msgBusca += `🤔 *Para completar sua lista, o que você prefere?*\n`;
            for (const { intencao, opcoes } of itensAmbiguos) {
                msgBusca += `• Para o *${intencao.item}*, tem ${opcoes.map(o => `*${o.produto_nome}*`).join(' ou ')}?\n`;
            }
        }

        if (itensAchados.length > 0) {
            const top3 = itensAchados.slice(0, 3);
            const botoes = top3.map(({ oferta }, idx) => ({
                id: `revelar_${oferta.id}_${oferta.loja_id}`,
                title: `🔓 Revelar Op. ${idx + 1}`,
            }));
            if (itensAmbiguos.length === 0) msgBusca += `👀 Deseja revelar a loja de qual opção?`;
            await sendInteractiveButtons(from, msgBusca, botoes);
        } else {
            await sendTextMessage(from, msgBusca.trim());
        }
        return true;
    }

    await sendTextMessage(from, 'O que você está procurando hoje? Pode digitar ex: "Pizza", "Leite", etc.');
    return true;
}
