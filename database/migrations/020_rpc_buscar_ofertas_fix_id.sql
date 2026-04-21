-- Adicionando 'id' na tabela de retorno para garantir o funcionamento do botão Revelar

DROP FUNCTION IF EXISTS buscar_ofertas(text, text, text, text);

CREATE OR REPLACE FUNCTION buscar_ofertas(
  p_cidade TEXT,
  p_bairro TEXT,
  p_estado TEXT,
  p_query  TEXT
)
RETURNS TABLE (
  id             UUID,
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
      ch.id                 AS id, -- Pegamos o ID da linha do histórico (pode ser o ativo)
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
        extensions.unaccent(ch.produto_nome) ILIKE extensions.unaccent('%' || p_query || '%')
        OR extensions.similarity(extensions.unaccent(ch.produto_nome), extensions.unaccent(p_query)) > 0.3
        OR to_tsvector('portuguese', extensions.unaccent(ch.produto_nome)) @@ websearch_to_tsquery('portuguese', extensions.unaccent(p_query))
      )
    ORDER BY
      ch.loja_id,
      LOWER(TRIM(extensions.unaccent(ch.produto_nome))),
      ch.preco ASC, 
      ch.registrado_em DESC
  ) sub
  ORDER BY preco_atual ASC;
$$;
