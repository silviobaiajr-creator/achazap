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
