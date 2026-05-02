-- Migration 025: Fix buscar_ofertas para usar catalogo_ativo + Regras de Negócio

DROP FUNCTION IF EXISTS buscar_ofertas(text, text, text, text);

CREATE OR REPLACE FUNCTION buscar_ofertas(
  p_cidade TEXT,
  p_bairro TEXT,
  p_estado TEXT,
  p_query  TEXT
)
RETURNS TABLE (
  id               UUID,
  loja_id          UUID,
  loja_nome        TEXT,
  whatsapp_loja    TEXT,
  faz_delivery     BOOLEAN,
  plano            VARCHAR(20),
  produto_nome     TEXT,
  produto_sku      TEXT,
  preco_atual      NUMERIC,
  unidade          TEXT,
  oferta_expira_em TIMESTAMPTZ,
  metadados        JSONB,
  registrado_em    TIMESTAMPTZ
)
LANGUAGE sql
STABLE
AS $$
  SELECT 
    c.id,
    l.id                  AS loja_id,
    l.nome                AS loja_nome,
    l.whatsapp            AS whatsapp_loja,
    l.faz_delivery,
    l.plano,
    c.produto_nome,
    COALESCE(c.produto_sku, '')  AS produto_sku,
    c.preco               AS preco_atual,
    c.unidade,
    c.oferta_expira_em,
    c.metadados,
    c.atualizado_em       AS registrado_em
  FROM catalogo_ativo c
  JOIN lojas l ON l.id = c.loja_id
  WHERE
    LOWER(TRIM(l.cidade))  = LOWER(TRIM(p_cidade))
    AND LOWER(TRIM(l.bairro)) = LOWER(TRIM(p_bairro))
    AND UPPER(TRIM(l.estado)) = UPPER(TRIM(p_estado))
    AND l.saldo_cliques > 0
    AND l.ativa       = true
    AND c.disponivel  = true
    AND (
      extensions.unaccent(c.produto_nome) ILIKE extensions.unaccent('%' || p_query || '%')
      OR extensions.similarity(extensions.unaccent(c.produto_nome), extensions.unaccent(p_query)) > 0.3
      OR to_tsvector('portuguese', extensions.unaccent(c.produto_nome)) @@ websearch_to_tsquery('portuguese', extensions.unaccent(p_query))
    )
  ORDER BY
    (l.plano = 'premium') DESC,              -- 1. Lojas Premium
    (c.oferta_expira_em > now()) DESC,       -- 2. Ofertas Relâmpago Ativas
    c.preco ASC,                             -- 3. Menor preço entre os similares
    RANDOM();                                -- 4. Rodízio justo para desempate
$$;
