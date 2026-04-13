-- ============================================================
-- AchaZap — Migration 010: catalogo_ativo como tabela real
-- Substitui o paradigma Append-Only na camada de BUSCA por um
-- modelo Snapshot (catálogo ativo) + Ledger (histórico auditável).
--
-- Contexto:
--   Antes: toda busca fazia DISTINCT ON em catalogo_historico (~N×)
--   Depois: buscas vão para catalogo_ativo (1 linha por produto)
--           e catalogo_historico vira trilha de auditoria pura.
--
-- EXECUTE NO PAINEL SUPABASE (SQL Editor) — Não é reversível via DROP.
-- ============================================================

-- ── 1. Extensões necessárias (idempotente) ──────────────────
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- ── 2. Wrapper IMMUTABLE do unaccent (idempotente) ──────────
CREATE OR REPLACE FUNCTION unaccent_immutable(text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$
  SELECT extensions.unaccent($1);
$$;

-- ── 3. Tabela catalogo_ativo ─────────────────────────────────
-- Cada produto de uma loja tem exatamente UMA linha aqui.
-- Atualizações de preço = UPDATE nesta tabela (não INSERT).
-- O INSERT vai para catalogo_historico como trilha de auditoria.
CREATE TABLE IF NOT EXISTS catalogo_ativo (
    id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    loja_id         UUID            NOT NULL REFERENCES lojas(id) ON DELETE RESTRICT,
    produto_nome    VARCHAR(250)    NOT NULL,
    produto_sku     VARCHAR(100),
    preco           NUMERIC(10,2)   NOT NULL CHECK (preco >= 0),
    unidade         VARCHAR(30)     NOT NULL DEFAULT 'un',
    disponivel      BOOLEAN         NOT NULL DEFAULT true,
    fonte_ingestao  VARCHAR(20)     NOT NULL DEFAULT 'manual'
                        CHECK (fonte_ingestao IN ('csv', 'foto', 'audio', 'manual')),
    criado_em       TIMESTAMPTZ     NOT NULL DEFAULT now(),
    atualizado_em   TIMESTAMPTZ     NOT NULL DEFAULT now(),

    -- Restrição: um produto por loja (upsert usa este conflito)
    CONSTRAINT uq_catalogo_ativo_loja_nome UNIQUE (loja_id, produto_nome)
);

COMMENT ON TABLE catalogo_ativo IS
    'Snapshot atual do catálogo: 1 linha por produto. Buscas e lookups usam esta tabela. Para histórico de preços, ver catalogo_historico.';

-- RLS
ALTER TABLE catalogo_ativo ENABLE ROW LEVEL SECURITY;

-- Trigger de atualizado_em
CREATE TRIGGER trg_catalogo_ativo_atualizado_em
    BEFORE UPDATE ON catalogo_ativo
    FOR EACH ROW EXECUTE FUNCTION fn_set_atualizado_em();

-- ── 4. Índice GIN fonético em catalogo_ativo ────────────────
-- Troca: GiST do arquivo 007 (lento em reads) → GIN (3-5× mais rápido)
-- O índice antigo em catalogo_historico continua existindo para auditoria.
DROP INDEX IF EXISTS idx_catalogo_fuzzy_trgm;  -- remove GiST do 007

CREATE INDEX IF NOT EXISTS idx_catalogo_ativo_trgm_gin
    ON catalogo_ativo
    USING GIN (unaccent_immutable(lower(produto_nome)) gin_trgm_ops)
    WHERE disponivel = true;

-- Índice auxiliar para lookups diretos por loja+nome (upsert e dedup)
CREATE INDEX IF NOT EXISTS idx_catalogo_ativo_loja_nome
    ON catalogo_ativo (loja_id, produto_nome)
    WHERE disponivel = true;

-- ── 5. Migrar dados: catalogo_historico → catalogo_ativo ────
-- Pega o registro mais recente por (loja_id, produto_nome).
-- ON CONFLICT DO NOTHING protege contra re-execuções acidentais.
INSERT INTO catalogo_ativo (
    loja_id, produto_nome, produto_sku, preco, unidade,
    disponivel, fonte_ingestao, criado_em, atualizado_em
)
SELECT DISTINCT ON (loja_id, COALESCE(produto_sku, produto_nome))
    loja_id,
    produto_nome,
    produto_sku,
    preco,
    unidade,
    disponivel,
    fonte_ingestao,
    registrado_em AS criado_em,
    registrado_em AS atualizado_em
FROM catalogo_historico
ORDER BY
    loja_id,
    COALESCE(produto_sku, produto_nome),
    registrado_em DESC
ON CONFLICT (loja_id, produto_nome) DO NOTHING;

-- ── 6. Adicionar FK produto_id em catalogo_historico ────────
-- Liga cada evento histórico ao produto real em catalogo_ativo.
-- Nullable para compatibilidade com registros anteriores à migration.
ALTER TABLE catalogo_historico
    ADD COLUMN IF NOT EXISTS produto_id UUID REFERENCES catalogo_ativo(id);

-- Preenche a FK nos registros existentes (melhor esforço)
UPDATE catalogo_historico ch
SET    produto_id = ca.id
FROM   catalogo_ativo ca
WHERE  ch.loja_id = ca.loja_id
  AND  ch.produto_nome = ca.produto_nome
  AND  ch.produto_id IS NULL;

-- ── 7. Recriar RPC apontando para catalogo_ativo ────────────
-- A função usa a tabela Ativa (1 linha por produto),
-- eliminando o DISTINCT ON no hot-path de busca.
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
    SELECT
        ca.id,
        ca.produto_nome,
        ca.preco,
        ca.unidade
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

-- ── 8. Atualizar a VIEW vw_catalogo_ativo ───────────────────
-- Agora aponta para a tabela real, sem DISTINCT ON custoso.
CREATE OR REPLACE VIEW vw_catalogo_ativo AS
SELECT
    id,
    loja_id,
    produto_nome,
    produto_sku,
    preco,
    unidade,
    disponivel,
    fonte_ingestao,
    atualizado_em AS registrado_em  -- alias para compatibilidade com código legado
FROM catalogo_ativo
WHERE disponivel = true;

COMMENT ON VIEW vw_catalogo_ativo IS
    'Catálogo V3: Espelho direto da tabela catalogo_ativo. Sem DISTINCT ON. Zero custo de CPU.';

-- ── Verificação pós-migration ────────────────────────────────
-- Execute as queries abaixo para checar:
-- SELECT COUNT(*) FROM catalogo_ativo;               -- deve ter N produtos únicos
-- SELECT COUNT(*) FROM catalogo_historico;           -- deve ser >= ao anterior
-- SELECT * FROM buscar_produtos_similares('<loja_id>', 'dipirona', 0.15);
