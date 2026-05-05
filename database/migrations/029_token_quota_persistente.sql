-- ================================================================
-- Migration 029: Quota Global de Tokens (Anti-Custo-Explosão)
-- ================================================================
-- O fusível de tokens estava na RAM (MemoryCache).
-- Um restart do servidor zerava o contador e o limite deixava de existir.
-- Esta tabela persiste o gasto diário de tokens no banco — imune a restarts.

CREATE TABLE IF NOT EXISTS public.token_quota_diaria (
    data        DATE        NOT NULL DEFAULT CURRENT_DATE,
    chave       TEXT        NOT NULL, -- ex: 'global', 'loja:uuid', 'worker'
    total       BIGINT      NOT NULL DEFAULT 0,
    bloqueado   BOOLEAN     NOT NULL DEFAULT false,
    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (data, chave)
);

COMMENT ON TABLE public.token_quota_diaria IS
    'Contador persistente de tokens Gemini por dia. Sobrevive a restarts do servidor. Reseta automaticamente a cada novo dia (chave de data).';

-- Função para incrementar tokens atomicamente (evita race condition)
CREATE OR REPLACE FUNCTION incrementar_token_quota(
    p_chave     TEXT,
    p_tokens    BIGINT,
    p_limite    BIGINT
)
RETURNS TABLE(total_novo BIGINT, bloqueado BOOLEAN)
LANGUAGE plpgsql AS $$
DECLARE
    v_total BIGINT;
    v_bloqueado BOOLEAN;
BEGIN
    INSERT INTO public.token_quota_diaria (data, chave, total, bloqueado)
    VALUES (CURRENT_DATE, p_chave, p_tokens, false)
    ON CONFLICT (data, chave) DO UPDATE
        SET total         = token_quota_diaria.total + p_tokens,
            bloqueado     = (token_quota_diaria.total + p_tokens) >= p_limite,
            atualizado_em = now()
    RETURNING token_quota_diaria.total, token_quota_diaria.bloqueado
    INTO v_total, v_bloqueado;

    RETURN QUERY SELECT v_total, v_bloqueado;
END;
$$;

-- Função para verificar se já está bloqueado (leitura rápida)
CREATE OR REPLACE FUNCTION verificar_quota_bloqueada(p_chave TEXT, p_limite BIGINT)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(
        (SELECT total >= p_limite FROM public.token_quota_diaria
         WHERE data = CURRENT_DATE AND chave = p_chave),
        false
    );
$$;

-- View para consulta rápida do status diário
CREATE OR REPLACE VIEW public.v_token_quota_hoje AS
    SELECT chave, total, bloqueado, atualizado_em
    FROM public.token_quota_diaria
    WHERE data = CURRENT_DATE
    ORDER BY total DESC;
