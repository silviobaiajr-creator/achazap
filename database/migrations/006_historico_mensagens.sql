-- =============================================================
-- AchaZap — Migration 006: Histórico de Mensagens (Memória)
-- =============================================================

CREATE TABLE IF NOT EXISTS historico_mensagens (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  whatsapp      VARCHAR(20)   NOT NULL,         -- De quem é a conversa
  role          VARCHAR(10)   NOT NULL,         -- 'user' | 'model'
  content       TEXT          NOT NULL,         -- Texto da mensagem
  criado_em     TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- Índice para busca rápida das últimas mensagens por usuário
CREATE INDEX IF NOT EXISTS idx_historico_whatsapp ON historico_mensagens (whatsapp, criado_em DESC);

COMMENT ON TABLE historico_mensagens IS 'Memória de curto prazo para conversas da IA';
