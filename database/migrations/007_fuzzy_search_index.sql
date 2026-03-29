-- =============================================================
-- AchaZap — Migration 007: Índice GIST para Trigramas
-- =============================================================
-- Melhora a performance de similarity(unaccent(produto_nome), ...)

-- Requer extensão unaccent e pg_trgm (já habilitadas na migration 004)

-- Recomendado limpar o cache e recriar o índice para garantir consistência
CREATE INDEX IF NOT EXISTS idx_catalogo_fuzzy_trgm 
ON catalogo_historico 
USING GIST (unaccent(produto_nome) gist_trgm_ops);

COMMENT ON INDEX idx_catalogo_fuzzy_trgm IS 
'Índice para busca inteligente por similaridade e trigramas.';
