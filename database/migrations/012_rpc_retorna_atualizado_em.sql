-- ============================================================
-- AchaZap — Migration 012: RPC buscar_produtos_similares
-- Adiciona atualizado_em ao retorno para o bot exibir o
-- selo de frescor correto nos cards de confirmação.
-- ============================================================

DROP FUNCTION IF EXISTS buscar_produtos_similares(uuid, text, float);

CREATE OR REPLACE FUNCTION buscar_produtos_similares(
    p_loja_id   UUID,
    p_termo     TEXT,
    p_threshold FLOAT DEFAULT 0.15
)
RETURNS TABLE (
    id            UUID,
    produto_nome  TEXT,
    preco         NUMERIC,
    unidade       TEXT,
    atualizado_em TIMESTAMPTZ
)
LANGUAGE sql STABLE
AS $$
    SELECT
        ca.id,
        ca.produto_nome,
        ca.preco,
        ca.unidade,
        ca.atualizado_em
    FROM catalogo_ativo ca
    WHERE ca.loja_id = p_loja_id
      AND ca.disponivel = true
      AND similarity(
            unaccent_immutable(lower(ca.produto_nome)),
            unaccent_immutable(lower(p_termo))
          ) > p_threshold
    ORDER BY
        similarity(
            unaccent_immutable(lower(ca.produto_nome)),
            unaccent_immutable(lower(p_termo))
        ) DESC;
$$;

-- Verificação pós-migration:
-- SELECT * FROM buscar_produtos_similares('<loja_id>', 'arroz', 0.15);
-- Deve retornar a coluna atualizado_em preenchida.
