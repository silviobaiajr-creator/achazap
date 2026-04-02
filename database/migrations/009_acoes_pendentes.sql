-- =============================================================
-- AchaZap — Migration 009: Ações Pendentes de Confirmação
-- =============================================================

CREATE TABLE IF NOT EXISTS acoes_pendentes (
    id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    whatsapp        VARCHAR(20)   NOT NULL,
    tipo            VARCHAR(20)   NOT NULL,  -- 'cadastro_produto', 'criar_oferta'
    dados           JSONB         NOT NULL,  -- dados a serem confirmados
    criado_em       TIMESTAMPTZ   NOT NULL DEFAULT now(),
    expira_em       TIMESTAMPTZ   NOT NULL DEFAULT (now() + interval '15 minutes')
);

CREATE INDEX IF NOT EXISTS idx_acoes_pendentes_whatsapp ON acoes_pendentes (whatsapp, criado_em DESC);

COMMENT ON TABLE acoes_pendentes IS 'Ações aguardando confirmação do lojista (cadastro produto, oferta)';
