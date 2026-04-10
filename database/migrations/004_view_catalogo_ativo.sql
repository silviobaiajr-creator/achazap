-- =============================================================
-- AchaZap — Migration 004: View de Catálogo Ativo (V2 Scale-Up)
-- Banco: PostgreSQL (Supabase)
-- =============================================================
-- Soluciona o requisito Legal (CDC) de não indexar preços velhos.

-- 1. Cria a VIEW materializada em tempo real (view simples) para o catálogo ativo.
-- Utiliza DISTINCT ON para pegar apenas o evento mais recente de cada produto.
-- Aplica a regra de expiração de 7 dias automáticos.

CREATE OR REPLACE VIEW vw_catalogo_ativo AS
SELECT DISTINCT ON (loja_id, produto_nome)
    id,
    loja_id,
    produto_nome,
    produto_sku,
    preco,
    unidade,
    disponivel,
    fonte_ingestao,
    registrado_em
FROM catalogo_historico
WHERE 
    registrado_em >= NOW() - INTERVAL '7 days'
    AND disponivel = true
ORDER BY 
    loja_id, 
    produto_nome, 
    registrado_em DESC;

COMMENT ON VIEW vw_catalogo_ativo IS 'Catálogo V2: Exibe apenas preços ativos e atualizados nos últimos 7 dias. Oculta deleções (disponivel=false)';
