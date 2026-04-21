-- ============================================================
-- AchaZap — Migration 021: Modelo de 6 Camadas de Precisão
-- Objetivo: Enriquecer o catálogo de produtos com colunas
-- estruturadas para permitir buscas inteligentes por atributo
-- (marca, especificação, tamanho, etc.) em vez de só texto bruto.
--
-- EXECUTE NO PAINEL SUPABASE (SQL Editor)
-- Operação segura: apenas ADD COLUMN IF NOT EXISTS (idempotente)
-- ============================================================

-- ── 1. Enriquecer catalogo_ativo ──────────────────────────────
ALTER TABLE public.catalogo_ativo
    ADD COLUMN IF NOT EXISTS membro_core   TEXT,   -- O produto base (ex: "Arroz", "Café")
    ADD COLUMN IF NOT EXISTS marca         TEXT,   -- Marca comercial (ex: "Tio João", "Santa Clara")
    ADD COLUMN IF NOT EXISTS especificacao TEXT,   -- Tipo/preparo (ex: "Integral", "Vácuo", "Refinado")
    ADD COLUMN IF NOT EXISTS unidade_medida TEXT,  -- Medida legível (ex: "5kg", "250g", "1L")
    ADD COLUMN IF NOT EXISTS metadados     JSONB;  -- Tags extras livres (ex: {"tags": ["Gourmet","Orgânico"]})

COMMENT ON COLUMN public.catalogo_ativo.membro_core   IS 'Identidade base do produto, extraída via IA para buscas semânticas precisas.';
COMMENT ON COLUMN public.catalogo_ativo.marca          IS 'Marca comercial do produto, usada para diferenciar variantes da IA de consumidor.';
COMMENT ON COLUMN public.catalogo_ativo.especificacao  IS 'Tipo ou preparo do produto (ex: Integral, Vácuo, Cristal).';
COMMENT ON COLUMN public.catalogo_ativo.unidade_medida IS 'Medida de peso/volume em formato legível (ex: 5kg, 250g).';
COMMENT ON COLUMN public.catalogo_ativo.metadados      IS 'Bolso de JSON livre para tags adicionais (Gourmet, Orgânico, etc).';

-- ── 2. Espelhar as mesmas colunas em catalogo_historico ───────
-- O histórico deve ter os mesmos campos para auditoria completa.
ALTER TABLE public.catalogo_historico
    ADD COLUMN IF NOT EXISTS membro_core   TEXT,
    ADD COLUMN IF NOT EXISTS marca         TEXT,
    ADD COLUMN IF NOT EXISTS especificacao TEXT,
    ADD COLUMN IF NOT EXISTS unidade_medida TEXT,
    ADD COLUMN IF NOT EXISTS metadados     JSONB;

-- ── 3. Índice auxiliar para buscas por membro_core + marca ────
-- Permite filtros rápidos no loop de ambiguidade do consumidor
-- (ex: "todos os tipos de Café da região")
CREATE INDEX IF NOT EXISTS idx_catalogo_ativo_membro_core
    ON public.catalogo_ativo (membro_core)
    WHERE disponivel = true AND membro_core IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_catalogo_ativo_marca
    ON public.catalogo_ativo (marca)
    WHERE disponivel = true AND marca IS NOT NULL;

-- ── Verificação pós-migration ─────────────────────────────────
-- SELECT column_name FROM information_schema.columns
-- WHERE table_name = 'catalogo_ativo'
-- AND column_name IN ('membro_core','marca','especificacao','unidade_medida','metadados');
-- Deve retornar 5 rows.
