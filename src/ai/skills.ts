import { supabase } from '../lib/supabase.js';
import { randomUUID } from 'crypto';

// ============================================================
// SKILL: buscar_ofertas_por_regiao
// ============================================================
export async function buscarOfertasPorRegiao(args: {
    cidade: string;
    bairro: string;
    query: string;
}) {
    // Busca o produto mais recente de cada loja disponível na região
    const { data, error } = await supabase.rpc('buscar_ofertas', {
        p_cidade: args.cidade,
        p_bairro: args.bairro,
        p_query: args.query,
    });

    if (error) throw new Error(`buscar_ofertas: ${error.message}`);
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
        debitado: false,          // ainda não debitado (aguarda o clique)
        motivo_skip: 'pendente',  // será null após o clique real
    });

    if (error) throw new Error(`gerar_link: ${error.message}`);

    const redirectLink = `${process.env.BASE_URL ?? 'https://seudominio.com'}/r?token=${token}&wa=${encodeURIComponent(waLink)}`;

    return { redirect_link: redirectLink, mensagem_preview: mensagem, token };
}

// ============================================================
// SKILL: cadastrar_atualizar_usuario
// ============================================================
export async function cadastrarAtualizarUsuario(args: {
    whatsapp: string;
    nome?: string;
    cidade: string;
    bairro: string;
}) {
    const { data: existente } = await supabase
        .from('usuarios')
        .select('id')
        .eq('whatsapp', args.whatsapp)
        .single();

    if (existente) {
        await supabase
            .from('usuarios')
            .update({ cidade: args.cidade, bairro: args.bairro, nome: args.nome })
            .eq('whatsapp', args.whatsapp);
        return { usuario_id: existente.id, novo_cadastro: false };
    }

    const { data, error } = await supabase
        .from('usuarios')
        .insert({ whatsapp: args.whatsapp, nome: args.nome, cidade: args.cidade, bairro: args.bairro })
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
        .select('id, nome, cidade, bairro')
        .eq('whatsapp', args.whatsapp)
        .single();

    return data ?? null;
}
