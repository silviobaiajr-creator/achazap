-- ============================================================
-- Migration 002: Busca de produtos similares com pg_trgm
-- Status: EXECUTADA COM SUCESSO em 02/04/2026
-- ============================================================

-- 1. Extensões
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- 2. Wrapper IMMUTABLE do unaccent
--    Necessário pois unaccent padrão é STABLE — índices exigem IMMUTABLE.
--    Padrão oficial PostgreSQL para este caso.
CREATE OR REPLACE FUNCTION unaccent_immutable(text)
RETURNS text
LANGUAGE sql
IMMUTABLE PARALLEL SAFE STRICT
AS $$
  SELECT extensions.unaccent($1);
$$;

-- 3. Índice GIN com trigrama para busca rápida de similaridade
DROP INDEX IF EXISTS idx_catalogo_trgm_nome;

CREATE INDEX idx_catalogo_trgm_nome
    ON catalogo_historico
    USING GIN (unaccent_immutable(lower(produto_nome)) gin_trgm_ops)
    WHERE disponivel = true;

-- 4. Função RPC: retorna candidatos similares (peneira matemática)
--    Chamada pelo orchestrator.ts antes do filtro semântico do Gemini.
--    Reduz custo de tokens em até 90% para lojas com muitos produtos.
DROP FUNCTION IF EXISTS buscar_produtos_similares(uuid, text, float);

CREATE OR REPLACE FUNCTION buscar_produtos_similares(
    p_loja_id   UUID,
    p_termo     TEXT,
    p_threshold FLOAT DEFAULT 0.15
)
RETURNS TABLE (
    id           UUID,
    produto_nome TEXT,
    preco        NUMERIC,
    unidade      TEXT
)
LANGUAGE sql STABLE
AS $$
    SELECT DISTINCT ON (lower(trim(ch.produto_nome)))
        ch.id,
        ch.produto_nome,
        ch.preco,
        ch.unidade
    FROM catalogo_historico ch
    WHERE ch.loja_id = p_loja_id
      AND ch.disponivel = true
      AND similarity(
            unaccent_immutable(lower(ch.produto_nome)),
            unaccent_immutable(lower(p_termo))
          ) > p_threshold
    ORDER BY
        lower(trim(ch.produto_nome)),
        similarity(
            unaccent_immutable(lower(ch.produto_nome)),
            unaccent_immutable(lower(p_termo))
        ) DESC,
        ch.registrado_em DESC;
$$;

-- 5. Verificação pós-criação
-- SELECT routine_name FROM information_schema.routines
-- WHERE routine_name IN ('buscar_produtos_similares', 'unaccent_immutable');
-- Deve retornar 2 rows.
