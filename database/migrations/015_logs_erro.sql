-- 015_logs_erro.sql
-- Tabela para persistência de erros críticos do sistema para auditoria via IA.

CREATE TABLE IF NOT EXISTS public.logs_erro (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ DEFAULT now(),
    origem TEXT NOT NULL, -- 'PROCESSOR', 'WEBHOOK', 'GLOBAL', etc
    whatsapp TEXT,       -- telefone do lojista envolvido (se houver)
    mensagem TEXT NOT NULL, -- Resumo humano
    stack_trace TEXT,     -- Detalhes técnicos (opcional)
    contexto JSONB        -- Dados extras da requisição
);

-- Index para facilitar a busca por tempo
CREATE INDEX IF NOT EXISTS idx_logs_erro_created_at ON public.logs_erro(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_erro_whatsapp ON public.logs_erro(whatsapp);
