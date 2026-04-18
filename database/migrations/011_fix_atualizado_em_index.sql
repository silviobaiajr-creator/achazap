-- ============================================================
-- AchaZap — Migration 011: Índice de performance + correção de dados
-- Problema: produtos cadastrados antes desta migration tinham
--           atualizado_em = criado_em (nunca explicitamente setado),
--           fazendo o /revisar os listar como "sem data".
-- ============================================================

-- 1. Índice para a query do /revisar (ORDER BY atualizado_em ASC)
--    Sem este índice, a query faz full-scan toda vez.
CREATE INDEX IF NOT EXISTS idx_catalogo_ativo_atualizado_em
    ON catalogo_ativo (loja_id, atualizado_em ASC)
    WHERE disponivel = true;

-- 2. Corrige produtos que estão com atualizado_em igual a criado_em
--    (situação default para registros antigos sem revisão explícita).
--    Após esta migration, esses produtos aparecerão no /revisar corretamente.
--    NOTA: não sobrescreve quem já tem atualizado_em > criado_em (já foi revisado).
UPDATE catalogo_ativo
SET    atualizado_em = criado_em
WHERE  atualizado_em IS NULL;

-- Verificação pós-migration:
-- SELECT COUNT(*) FROM catalogo_ativo WHERE atualizado_em IS NULL; -- deve ser 0
-- SELECT COUNT(*) FROM catalogo_ativo WHERE disponivel = true;
