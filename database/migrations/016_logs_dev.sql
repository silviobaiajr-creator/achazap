-- Migration 016: Tabela de Logs de Auditoria para Desenvolvimento
-- Esta tabela grava o fluxo completo do robô EXCLUSIVAMENTE para o número do dono.
-- Na produção real (lojistas normais), nenhum log é gravado aqui.
-- Tabela permanente: não há TTL automático. Pequeno volume pois é só para o Owner.

CREATE TABLE IF NOT EXISTS public.logs_dev (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at  TIMESTAMPTZ DEFAULT now(),
    whatsapp    TEXT NOT NULL,        -- Número que gerou o evento
    nivel       TEXT NOT NULL,        -- 'info', 'warn', 'error'
    contexto    TEXT NOT NULL,        -- Estado/estágio do fluxo (ex: 'AGUARDANDO_CONFIRMACAO')
    mensagem    TEXT NOT NULL,        -- O texto do log
    dados       JSONB                 -- Payload completo do evento (JSON estruturado)
);

-- Índices para que o diagnostics.ts seja rápido
CREATE INDEX IF NOT EXISTS idx_logs_dev_whatsapp     ON public.logs_dev(whatsapp);
CREATE INDEX IF NOT EXISTS idx_logs_dev_created_at   ON public.logs_dev(created_at DESC);

-- Comentário documental
COMMENT ON TABLE public.logs_dev IS 
    'Caixa-preta de auditoria de fluxo. Alimentada apenas pelo número ACHAZAP_OWNER_NUMBER para depuração. Não envolve lojistas reais.';
