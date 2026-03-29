-- 1. Criamos a NOSSA própria função apontando para a gaveta certa
CREATE OR REPLACE FUNCTION f_unaccent(text)
RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS
$$
  SELECT extensions.unaccent('extensions.unaccent', $1);
$$;

-- 2. Criamos o Índice de Alta Performance usando o nosso Clone
CREATE INDEX IF NOT EXISTS idx_catalogo_fuzzy_trgm
ON catalogo_historico
USING GIST (f_unaccent(produto_nome) gist_trgm_ops);