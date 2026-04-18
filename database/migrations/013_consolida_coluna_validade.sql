-- ============================================================
-- AchaZap — Migration 013: Consolida coluna de validade de preços
-- 
-- PROBLEMA: catalogo_ativo tinha duas tentativas de coluna de data:
--   - atualizado_em: coluna correta do schema (migration 010)
--   - updated_at: provavelmente adicionada por upserts anteriores
--
-- SOLUÇÃO: padronizar em atualizado_em e garantir trigger ativo.
-- ============================================================

-- 1. Garante que a função de trigger existe
CREATE OR REPLACE FUNCTION fn_set_atualizado_em()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.atualizado_em = now();
  RETURN NEW;
END;
$$;

-- 2. Registra o trigger em catalogo_ativo (idempotente)
DROP TRIGGER IF EXISTS trg_catalogo_ativo_atualizado_em ON catalogo_ativo;
CREATE TRIGGER trg_catalogo_ativo_atualizado_em
    BEFORE UPDATE ON catalogo_ativo
    FOR EACH ROW EXECUTE FUNCTION fn_set_atualizado_em();

-- 3. Se a coluna updated_at existir no banco, copia os valores
--    para atualizado_em onde fizerem sentido (mais antigos = precisam revisão)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'catalogo_ativo' AND column_name = 'updated_at'
    ) THEN
        -- Copia updated_at → atualizado_em apenas onde updated_at é MAIS ANTIGO
        -- (significa que foi o último ponto de atualização real via código antigo)
        UPDATE catalogo_ativo
        SET    atualizado_em = updated_at
        WHERE  updated_at IS NOT NULL
          AND  updated_at < atualizado_em;

        RAISE NOTICE 'Coluna updated_at encontrada. Dados sincronizados para atualizado_em.';
    ELSE
        RAISE NOTICE 'Coluna updated_at nao existe. Nenhuma sincronizacao necesaria.';
    END IF;
END;
$$;

-- 4. Índice de performance para /revisar (idempotente)
CREATE INDEX IF NOT EXISTS idx_catalogo_ativo_atualizado_em
    ON catalogo_ativo (loja_id, atualizado_em ASC)
    WHERE disponivel = true;

-- ── VERIFICAÇÕES PÓS-MIGRATION ──────────────────────────────
-- Execute estas queries para confirmar:
--
-- 1. Trigger ativo?
-- SELECT trigger_name, event_manipulation, action_timing
-- FROM information_schema.triggers
-- WHERE event_object_table = 'catalogo_ativo';
-- → Deve mostrar: trg_catalogo_ativo_atualizado_em | UPDATE | BEFORE
--
-- 2. Quais produtos precisam de revisão (> 6 dias)?
-- SELECT produto_nome, atualizado_em, now() - atualizado_em AS idade
-- FROM catalogo_ativo
-- WHERE disponivel = true
-- ORDER BY atualizado_em ASC
-- LIMIT 10;
