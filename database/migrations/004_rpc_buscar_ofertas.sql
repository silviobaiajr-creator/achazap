-- =============================================================
-- AchaZap — Migration 004: Função RPC buscar_ofertas
-- =============================================================
-- Usada pela skill buscarOfertasPorRegiao via supabase.rpc('buscar_ofertas', ...)
-- Retorna o preço MAIS RECENTE de cada produto por loja, filtrando por região.

CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE OR REPLACE FUNCTION buscar_ofertas(
  p_cidade TEXT,
  p_bairro TEXT,
  p_estado TEXT,
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
  SELECT * FROM (
    SELECT DISTINCT ON (ch.loja_id, LOWER(TRIM(extensions.unaccent(ch.produto_nome))))
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
      LOWER(TRIM(l.cidade))  = LOWER(TRIM(p_cidade))
      AND LOWER(TRIM(l.bairro)) = LOWER(TRIM(p_bairro))
      AND UPPER(TRIM(l.estado)) = UPPER(TRIM(p_estado))
      AND l.saldo_cliques > 0
      AND l.ativa       = true
      AND ch.disponivel = true
      AND (
        -- 1. Busca exata/insensível (unaccent + ilike)
        extensions.unaccent(ch.produto_nome) ILIKE extensions.unaccent('%' || p_query || '%')
        -- 2. Busca fuzzy (para erros de digitação leves)
        OR extensions.similarity(extensions.unaccent(ch.produto_nome), extensions.unaccent(p_query)) > 0.3
        -- 3. Fallback textual simples
        OR to_tsvector('portuguese', extensions.unaccent(ch.produto_nome)) @@ websearch_to_tsquery('portuguese', extensions.unaccent(p_query))
      )
    ORDER BY
      ch.loja_id,
      LOWER(TRIM(extensions.unaccent(ch.produto_nome))),
      ch.preco ASC, -- <--- REGRA DE OURO: O MENOR preço é SEMPRE o vencedor
      ch.registrado_em DESC
  ) sub
  ORDER BY preco_atual ASC;
$$;

COMMENT ON FUNCTION buscar_ofertas IS
  'Busca o preço mais recente de cada produto por loja, filtrando por cidade/bairro e full-text search. Exclui lojas sem saldo.';
