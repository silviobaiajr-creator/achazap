/**
 * Skill: store-services
 * Responsabilidade: Operações de banco relacionadas à loja (estatísticas, ofertas).
 */

import { supabaseAdmin as supabase } from '../../lib/supabase.js';

export async function obterEstatisticas(lojaId: string) {
    const { data: loja } = await supabase.from('lojas').select('saldo_cliques, ativa').eq('id', lojaId).single();
    const trintaDiasAtras = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { count } = await supabase.from('cliques_consumidos')
        .select('*', { count: 'exact', head: true })
        .eq('loja_id', lojaId)
        .eq('debitado', true)
        .gte('consumido_em', trintaDiasAtras);
    return { saldo: loja?.saldo_cliques ?? 0, status: loja?.ativa ? 'Ativa' : 'Pausada', cliques_30d: count || 0 };
}

export async function criarOferta(lojaId: string, dados: any): Promise<void> {
    const { error } = await supabase.from('ofertas_desconto').insert({
        loja_id:        lojaId,
        valor_minimo:   dados.valor_minimo,
        percentual:     dados.percentual,
        validade:       dados.validade,
        produto_filtro: dados.produto_filtro || null,
    });
    if (error) throw error;
}

export async function buscarOfertasAtivas(lojaId: string) {
    const { data } = await supabase.from('ofertas_desconto').select('*').eq('loja_id', lojaId).gte('validade', new Date().toISOString().split('T')[0]);
    return data || [];
}

/**
 * Ativa uma Oferta Relâmpago (Panfleto) em um produto do catálogo.
 * Atualiza o preço e define a expiração automática para a meia-noite do dia corrente.
 */
export async function ativarPanfleto(produtoId: string, novoPreco: number): Promise<void> {
    // Meia-noite do dia corrente (UTC)
    const meianoite = new Date();
    meianoite.setHours(24, 0, 0, 0);

    const { error } = await supabase
        .from('catalogo_ativo')
        .update({
            preco: novoPreco,
            oferta_expira_em: meianoite.toISOString(),
        })
        .eq('id', produtoId);

    if (error) throw error;
}

/**
 * Remove as Ofertas Relâmpago vencidas (expiradas).
 * Deve ser chamado por um worker periódico ou no início do dia.
 */
export async function limparPanfletosVencidos(): Promise<number> {
    const { data, error } = await supabase
        .from('catalogo_ativo')
        .update({ oferta_expira_em: null })
        .lt('oferta_expira_em', new Date().toISOString())
        .not('oferta_expira_em', 'is', null)
        .select('id');

    if (error) throw error;
    return data?.length ?? 0;
}

