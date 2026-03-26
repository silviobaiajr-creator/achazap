-- =============================================================
-- AchaZap — Migration 004: Função RPC buscar_ofertas
-- =============================================================
-- Usada pela skill buscarOfertasPorRegiao via supabase.rpc('buscar_ofertas', ...)
-- Retorna o preço MAIS RECENTE de cada produto por loja, filtrando por região.

CREATE OR REPLACE FUNCTION buscar_ofertas(
  p_cidade TEXT,
  p_bairro TEXT,
  p_query  TEXT
)
RETURNS TABLE (
  loja_id        UUID,
  loja_nome      TEXT,
  whatsapp_loja  TEXT,
  faz_delivery   BOOLEAN,
  produto_nome   TEXT,
  produto_sku    TEXT,
  preco_atual    NUMERIC,
  unidade        TEXT,
  registrado_em  TIMESTAMPTZ
)
LANGUAGE sql
STABLE
AS $$
  SELECT DISTINCT ON (ch.loja_id, ch.produto_nome)
    l.id                  AS loja_id,
    l.nome                AS loja_nome,
    l.whatsapp            AS whatsapp_loja,
    l.faz_delivery,
    ch.produto_nome,
    COALESCE(ch.produto_sku, '')  AS produto_sku,
    ch.preco              AS preco_atual,
    ch.unidade,
    ch.registrado_em
  FROM catalogo_historico ch
  JOIN lojas l ON l.id = ch.loja_id
  WHERE
    l.cidade          = p_cidade
    AND l.bairro      = p_bairro
    AND l.saldo_cliques > 0
    AND l.ativa       = true
    AND ch.disponivel = true
    AND to_tsvector('portuguese', ch.produto_nome)
        @@ plainto_tsquery('portuguese', p_query)
  ORDER BY
    ch.loja_id,
    ch.produto_nome,
    ch.registrado_em DESC;
$$;

COMMENT ON FUNCTION buscar_ofertas IS
  'Busca o preço mais recente de cada produto por loja, filtrando por cidade/bairro e full-text search. Exclui lojas sem saldo.';
