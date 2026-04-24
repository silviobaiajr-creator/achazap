/**
 * Skill: revisor
 * Responsabilidade: Geração e exibição do relatório de revisão de preços desatualizados.
 * Integra com o banco e envia a lista formatada para o lojista via WhatsApp.
 */

import { supabaseAdmin as supabase } from '../../lib/supabase.js';
import { sendTextMessage } from '../../lib/whatsapp.js';
import { salvarContexto } from '../../lib/redis-cloud.js';
import { EstadosFluxo, AlteracaoPlanejada } from '../types.js';

/**
 * Calcula o nível de frescor do preço baseado na data de atualização.
 */
export function calcularSeloFrescor(dataIso?: string | null): string {
    if (!dataIso) return '🚨 Sem data';
    try {
        const data   = new Date(dataIso);
        const agora  = new Date();
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

/**
 * Busca os itens com preços mais antigos e envia o relatório ao lojista.
 */
export async function processarRevisaoPrecos(from: string, loja: any): Promise<void> {
    const [{ data: semData }, { data: comData }] = await Promise.all([
        supabase
            .from('catalogo_ativo')
            .select('produto_nome, preco, unidade, atualizado_em')
            .eq('loja_id', loja.id)
            .eq('disponivel', true)
            .is('atualizado_em', null)
            .limit(10),
        supabase
            .from('catalogo_ativo')
            .select('produto_nome, preco, unidade, atualizado_em')
            .eq('loja_id', loja.id)
            .eq('disponivel', true)
            .not('atualizado_em', 'is', null)
            .order('atualizado_em', { ascending: true })
            .limit(10),
    ]);

    const todos = [...(semData ?? []), ...(comData ?? [])];

    const pendentes = todos.filter(item => {
        if (!item.atualizado_em) return true;
        const data = new Date(item.atualizado_em);
        const agora = new Date();
        const diffDias = Math.floor((agora.getTime() - data.getTime()) / (1000 * 60 * 60 * 24));
        return diffDias >= 6;
    }).slice(0, 8);

    if (pendentes.length === 0) {
        await sendTextMessage(from, '✅ *Tudo verdinho!* Todos os seus preços foram atualizados recentemente e estão com selo de confiança dos clientes. Bom trabalho!\n\n_Envie a palavra *Menu* para voltar às opções._');
        return;
    }

    let relatorio = `📋 *Relatório de Vencimento de Preços*\n`;
    relatorio += `${pendentes.length} item(s) precisam de atenção:\n\n`;

    const alteracoes: AlteracaoPlanejada[] = [];

    pendentes.forEach((item, i) => {
        const selo = calcularSeloFrescor(item.atualizado_em);
        relatorio += `*${i+1}. ${item.produto_nome}*\n💰 R$ ${Number(item.preco).toFixed(2).replace('.', ',')} / ${item.unidade} ${selo}\n`;
        alteracoes.push({
            nome:      item.produto_nome,
            precoFoto: Number(item.preco),
            unidade:   item.unidade,
            acao:      'preco_atualizado',
            dataReferencia: item.atualizado_em,
        });
    });

    const ex1 = pendentes.length >= 1 ? `*1 - ${Number(pendentes[0]!.preco).toFixed(2).replace('.', ',')}*` : '*1 - 0,00*';
    const ex2 = pendentes.length >= 2 ? `\n*2 - ${Number(pendentes[1]!.preco).toFixed(2).replace('.', ',')}*` : '';
    relatorio += `\n✍️ Digite o número e o novo preço.\nExemplo:\n${ex1}${ex2}\n\n_Você pode atualizar vários de uma vez!_\n\n🛑 *Para cancelar a revisão, digite 0*`;

    // Busca a contagem total de produtos desatualizados para o progresso real (Cenário 15)
    const dataReferenciaTotal = new Date();
    dataReferenciaTotal.setDate(dataReferenciaTotal.getDate() - 3); // Mesmo critério de 3 dias
    const { count: totalGeral } = await supabase
        .from('catalogo_ativo')
        .select('*', { count: 'exact', head: true })
        .eq('loja_id', loja.id)
        .lt('atualizado_em', dataReferenciaTotal.toISOString());

    await salvarContexto(from, {
        estado:              EstadosFluxo.AGUARDANDO_SELECAO_REVISAO,
        alteracoesPlanejadas: alteracoes,
        totalItensRevisao:   totalGeral || alteracoes.length,
        perguntaPendente:    'Digite o número e o novo preço. (Digite 0 para cancelar)',
    });

    await sendTextMessage(from, relatorio);
}
