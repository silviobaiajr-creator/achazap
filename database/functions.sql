-- ============================================================
-- AchaZap — Função SQL de Busca de Ofertas
-- Execute no SQL Editor do Supabase APÓS o schema.sql
-- ============================================================

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
  preco_atual    NUMERIC,
  unidade        TEXT,
  registrado_em  TIMESTAMPTZ
)
LANGUAGE sql
STABLE
AS $$
  -- Para cada loja ativa com saldo na região, retorna o preço mais recente
  -- de produtos que correspondem ao termo de busca
  SELECT DISTINCT ON (l.id, ch.produto_nome)
    l.id              AS loja_id,
    l.nome            AS loja_nome,
    l.whatsapp        AS whatsapp_loja,
    l.faz_delivery,
    ch.produto_nome,
    ch.preco          AS preco_atual,
    ch.unidade,
    ch.registrado_em
  FROM lojas l
  JOIN catalogo_historico ch ON ch.loja_id = l.id
  WHERE
    l.ativa          = true
    AND l.saldo_cliques > 0
    AND lower(l.cidade) = lower(p_cidade)
    AND lower(l.bairro) = lower(p_bairro)
    AND ch.disponivel  = true
    AND lower(ch.produto_nome) ILIKE '%' || lower(p_query) || '%'
  ORDER BY
    l.id,
    ch.produto_nome,
    ch.registrado_em DESC,  -- pega o preço mais recente
    ch.preco ASC             -- em caso de empate, o mais barato
  LIMIT 20;
$$;
