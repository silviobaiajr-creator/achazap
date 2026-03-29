-- Limpar e recriar
DROP FUNCTION IF EXISTS buscar_ofertas(text, text, text, text);

CREATE OR REPLACE FUNCTION buscar_ofertas(
  p_cidade TEXT, p_bairro TEXT, p_estado TEXT, p_query TEXT
)
RETURNS TABLE (
  loja_id UUID, loja_nome TEXT, whatsapp_loja TEXT, faz_delivery BOOLEAN,
  produto_nome TEXT, produto_sku TEXT, preco_atual NUMERIC, unidade TEXT, registrado_em TIMESTAMPTZ
)
LANGUAGE sql STABLE
AS $$
  SELECT * FROM (
    SELECT DISTINCT ON (ch.loja_id, LOWER(TRIM(extensions.unaccent(ch.produto_nome))))
      l.id, l.nome, l.whatsapp, l.faz_delivery, ch.produto_nome,
      COALESCE(ch.produto_sku, ''), ch.preco, ch.unidade, ch.registrado_em
    FROM catalogo_historico ch
    JOIN lojas l ON l.id = ch.loja_id
    WHERE LOWER(TRIM(l.cidade)) = LOWER(TRIM(p_cidade))
      AND LOWER(TRIM(l.bairro)) = LOWER(TRIM(p_bairro))
      AND UPPER(TRIM(l.estado)) = UPPER(TRIM(p_estado))
      AND l.saldo_cliques > 0 AND l.ativa = true AND ch.disponivel = true
      AND extensions.unaccent(lower(ch.produto_nome)) ILIKE '%' || extensions.unaccent(lower(p_query)) || '%'
    ORDER BY ch.loja_id, LOWER(TRIM(extensions.unaccent(ch.produto_nome))), ch.preco ASC, ch.registrado_em DESC
  ) sub
  ORDER BY preco ASC;
$$;
