import { supabase } from '../lib/supabase.js';
import { randomUUID } from 'crypto';

// ============================================================
// SKILL: buscar_ofertas_por_regiao
// ============================================================
export async function buscarOfertasPorRegiao(args: {
    cidade: string;
    bairro: string;
    estado: string;
    query: string;
}) {
    // Busca o produto mais recente de cada loja disponível na região
    const { data, error } = await supabase.rpc('buscar_ofertas', {
        p_cidade: args.cidade,
        p_bairro: args.bairro,
        p_estado: args.estado,
        p_query: args.query,
    });

    if (error) throw new Error(`buscar_ofertas: ${error.message}`);
    console.log(`[Skills] buscarOfertas retornou ${data?.length || 0} itens para "${args.query}" em ${args.bairro}/${args.cidade}`);
    return data ?? [];
}

// ============================================================
// SKILL: analisar_historico_preco
// ============================================================
export async function analisarHistoricoPreco(args: {
    loja_id: string;
    produto_nome: string;
    janela_dias?: number;
}) {
    const dias = args.janela_dias ?? 90;
    const desde = new Date();
    desde.setDate(desde.getDate() - dias);

    const { data, error } = await supabase
        .from('catalogo_historico')
        .select('preco, registrado_em')
        .eq('loja_id', args.loja_id)
        .ilike('produto_nome', `%${args.produto_nome}%`)
        .gte('registrado_em', desde.toISOString())
        .order('registrado_em', { ascending: false });

    if (error) throw new Error(`analisar_historico: ${error.message}`);
    if (!data || data.length === 0) return null;

    const precos = data.map((r) => Number(r.preco));
    const precoAtual = precos[0];
    const precoMinimo = Math.min(...precos);
    const precoMaximo = Math.max(...precos);

    return {
        preco_atual: precoAtual,
        preco_minimo: precoMinimo,
        preco_maximo: precoMaximo,
        eh_preco_minimo: precoAtual <= precoMinimo,
        variacoes: data.length,
    };
}

// ============================================================
// SKILL: gerar_link_redirecionamento
// ============================================================
export async function gerarLinkRedirecionamento(args: {
    loja_id: string;
    usuario_id: string;
    produto_nome: string;
    preco: number;
    bairro: string;
    faz_delivery: boolean;
    whatsapp_loja: string;
}) {
    const token = randomUUID().replace(/-/g, '');
    const mensagem = args.faz_delivery
        ? `Olá! Vi no AchaZap que vocês têm *${args.produto_nome}* por R$ ${args.preco.toFixed(2)}. Quero solicitar uma entrega. 🛵`
        : `Olá! Vi no AchaZap que vocês têm *${args.produto_nome}* por R$ ${args.preco.toFixed(2)}. Estou indo buscar! 🏃`;

    const waLink = `https://wa.me/${args.whatsapp_loja.replace(/\D/g, '')}?text=${encodeURIComponent(mensagem)}`;

    // Salva o token pendente para o endpoint /r?token processar ao clicar
    const { error } = await supabase.from('cliques_consumidos').insert({
        loja_id: args.loja_id,
        usuario_id: args.usuario_id,
        produto_ref: args.produto_nome,
        link_token: token,
        link_gerado: waLink,      // SALVA O LINK COMPLETO NO BANCO
        debitado: false,          // ainda não debitado (aguarda o clique)
        motivo_skip: 'pendente',  // será null após o clique real
    });

    if (error) throw new Error(`gerar_link: ${error.message}`);

    return { token };
}

// ============================================================
// SKILL: cadastrar_atualizar_usuario
// ============================================================
export async function cadastrarAtualizarUsuario(args: {
    whatsapp: string;
    nome?: string;
    cidade: string;
    bairro: string;
    estado: string;
}) {
    const { data: existente } = await supabase
        .from('usuarios')
        .select('id')
        .eq('whatsapp', args.whatsapp)
        .single();

    if (existente) {
        await supabase
            .from('usuarios')
            .update({ cidade: args.cidade, bairro: args.bairro, estado: args.estado, nome: args.nome })
            .eq('whatsapp', args.whatsapp);
        return { usuario_id: existente.id, novo_cadastro: false };
    }

    const { data, error } = await supabase
        .from('usuarios')
        .insert({ 
            whatsapp: args.whatsapp, 
            nome: args.nome, 
            cidade: args.cidade, 
            bairro: args.bairro,
            estado: args.estado 
        })
        .select('id')
        .single();

    if (error) throw new Error(`cadastrar_usuario: ${error.message}`);
    return { usuario_id: data.id, novo_cadastro: true };
}

// ============================================================
// SKILL: obter_perfil_usuario
// ============================================================
export async function obterPerfilUsuario(args: { whatsapp: string }) {
    const { data } = await supabase
        .from('usuarios')
        .select('id, nome, cidade, bairro, estado')
        .eq('whatsapp', args.whatsapp)
        .single();

    if (data) {
        console.log(`[Skills] Perfil encontrado para ${args.whatsapp}:`, data.nome, data.cidade);
    } else {
        console.log(`[Skills] Perfil NÃO encontrado para ${args.whatsapp}`);
    }
    return data ?? null;
}

// ============================================================
// SKILL: obter_perfil_loja
// ============================================================
export async function obterPerfilLoja(args: { whatsapp: string }) {
    const { data } = await supabase
        .from('lojas')
        .select('id, nome, cidade, bairro, estado, saldo_cliques, ativa')
        .eq('whatsapp', args.whatsapp)
        .single();

    return data ?? null;
}

// ============================================================
// SKILL: ingerir_catalogo
// ============================================================
export async function ingerirCatalogo(args: {
    loja_id: string;
    itens: { produto_nome: string; preco: number; unidade?: string }[];
    fonte_ingestao: 'csv' | 'foto' | 'audio' | 'manual';
}) {
    if (!args.itens || args.itens.length === 0) return { sucesso: false, inseridos: 0 };

    const payload = args.itens.map(item => ({
        loja_id: args.loja_id,
        produto_nome: item.produto_nome,
        preco: item.preco,
        unidade: item.unidade ?? 'un',
        disponivel: true,
        fonte_ingestao: args.fonte_ingestao,
    }));

    const { error, data } = await supabase
        .from('catalogo_historico')
        .insert(payload)
        .select('id');

    if (error) throw new Error(`ingerir_catalogo: ${error.message}`);
    return { sucesso: true, inseridos: data.length };
}

// ============================================================
// SKILL: obter_estatisticas_loja
// ============================================================
export async function obterEstatisticasLoja(args: { loja_id: string }) {
    // 1. Saldo e Status
    const { data: loja, error: errorLoja } = await supabase
        .from('lojas')
        .select('saldo_cliques, ativa')
        .eq('id', args.loja_id)
        .single();

    if (errorLoja) throw new Error(`obter_estatisticas (loja): ${errorLoja.message}`);

    // 2. Cliques Totais (últimos 30 dias)
    const trintaDiasAtras = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { count: cliquesTotal } = await supabase
        .from('cliques_consumidos')
        .select('*', { count: 'exact', head: true })
        .eq('loja_id', args.loja_id)
        .eq('debitado', true)
        .gte('consumido_em', trintaDiasAtras);

    // 3. Top 3 Produtos mais clicados
    const { data: topProdutos } = await supabase
        .from('cliques_consumidos')
        .select('produto_ref')
        .eq('loja_id', args.loja_id)
        .eq('debitado', true);

    // Processamento manual do ranking (Supabase JS não faz Group By complexo nativamente no select)
    const ranking: Record<string, number> = {};
    topProdutos?.forEach(p => {
        ranking[p.produto_ref] = (ranking[p.produto_ref] || 0) + 1;
    });

    const top3 = Object.entries(ranking)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([nome, total]) => ({ produto: nome, cliques: total }));

    return {
        saldo: loja.saldo_cliques,
        status: loja.ativa ? 'Ativa' : 'Pausada',
        cliques_30d: cliquesTotal || 0,
        ranking_top_3: top3
    };
}
