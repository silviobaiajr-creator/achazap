-- =============================================================================
-- Migration 030: Worker de Notificação — Alertas Real-Time de Ofertas
-- =============================================================================
-- Cria as tabelas de persistência das preferências de alerta dos consumidores.
-- Suporta dois modos:
--   'produto_desejado' → avisa sobre qualquer oferta do termo (preco_alvo NULL)
--   'sniper_preco'     → avisa somente se o preço for <= ao alvo informado
--
-- Regras Anti-Spam da Meta integradas:
--   - ultimo_envio: Controla o cooldown de 24h para Templates
--   - ultimo_engajamento: Controla se o 2º+ disparo do dia é gratuito (janela aberta)
-- =============================================================================

-- ── 1. Tabela de Preferências Gerais ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS consumidor_preferencias (
    whatsapp           TEXT        PRIMARY KEY,
    cidade             TEXT,
    bairro             TEXT,
    estado             TEXT,
    optin_geral        BOOLEAN     NOT NULL DEFAULT false,
    ultimo_envio       TIMESTAMPTZ,
    ultimo_engajamento TIMESTAMPTZ,
    criado_em          TIMESTAMPTZ NOT NULL DEFAULT now(),
    atualizado_em      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE  consumidor_preferencias                 IS 'Preferências de notificação proativa dos consumidores do AchaZap';
COMMENT ON COLUMN consumidor_preferencias.ultimo_envio    IS 'Último disparo de Template (custo Meta). Usado para Cooldown de 24h';
COMMENT ON COLUMN consumidor_preferencias.ultimo_engajamento IS 'Última resposta do consumidor. Se > ultimo_envio, janela está aberta e 2º disparo é gratuito';
COMMENT ON COLUMN consumidor_preferencias.optin_geral     IS 'Se verdadeiro, recebe o Panfleto Digital semanal (futuro)';

-- ── 2. Tabela de Alertas Específicos ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS consumidor_alertas (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    whatsapp    TEXT        NOT NULL REFERENCES consumidor_preferencias(whatsapp) ON DELETE CASCADE,
    tipo        TEXT        NOT NULL DEFAULT 'produto_desejado', -- 'produto_desejado' | 'sniper_preco'
    termo       TEXT        NOT NULL,    -- Ex: "Celular Samsung", "Picanha", "Heineken"
    preco_alvo  NUMERIC(10,2),           -- NULL = qualquer preço. Valor = somente se preço <= alvo
    ativo       BOOLEAN     NOT NULL DEFAULT true,
    criado_em   TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_tipo CHECK (tipo IN ('produto_desejado', 'sniper_preco')),
    CONSTRAINT chk_sniper_tem_preco CHECK (tipo != 'sniper_preco' OR preco_alvo IS NOT NULL)
);

COMMENT ON TABLE  consumidor_alertas            IS 'Alertas de ofertas cadastrados pelos consumidores';
COMMENT ON COLUMN consumidor_alertas.tipo       IS 'produto_desejado: avisa qualquer oferta. sniper_preco: avisa somente se preco <= preco_alvo';
COMMENT ON COLUMN consumidor_alertas.preco_alvo IS 'Apenas para tipo sniper_preco. NULL para tipo produto_desejado';
COMMENT ON COLUMN consumidor_alertas.ativo      IS 'false = alerta silenciado (após notificação ou opt-out)';

-- ── 3. Índices para performance do Worker ────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_alertas_ativo       ON consumidor_alertas(ativo) WHERE ativo = true;
CREATE INDEX IF NOT EXISTS idx_alertas_whatsapp    ON consumidor_alertas(whatsapp);
CREATE INDEX IF NOT EXISTS idx_alertas_termo       ON consumidor_alertas USING gin(to_tsvector('portuguese', termo));
CREATE INDEX IF NOT EXISTS idx_pref_ultimo_envio   ON consumidor_preferencias(ultimo_envio);

-- ── 4. Trigger: atualizar atualizado_em automaticamente ──────────────────────
CREATE OR REPLACE FUNCTION touch_atualizado_em()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.atualizado_em = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pref_atualizado_em ON consumidor_preferencias;
CREATE TRIGGER trg_pref_atualizado_em
    BEFORE UPDATE ON consumidor_preferencias
    FOR EACH ROW EXECUTE FUNCTION touch_atualizado_em();

-- ── 5. RPC: Registrar engajamento do consumidor (chamado pelo Orchestrator) ──
CREATE OR REPLACE FUNCTION registrar_engajamento_consumidor(p_whatsapp TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    UPDATE consumidor_preferencias
    SET ultimo_engajamento = now()
    WHERE whatsapp = p_whatsapp;
END;
$$;

-- ── 6. RPC: Criar ou atualizar preferência + alerta (upsert seguro) ──────────
CREATE OR REPLACE FUNCTION upsert_alerta_consumidor(
    p_whatsapp   TEXT,
    p_cidade     TEXT,
    p_bairro     TEXT,
    p_estado     TEXT,
    p_tipo       TEXT,
    p_termo      TEXT,
    p_preco_alvo NUMERIC DEFAULT NULL
)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_alerta_id UUID;
BEGIN
    -- Garante que a preferência geral existe (upsert)
    INSERT INTO consumidor_preferencias (whatsapp, cidade, bairro, estado)
    VALUES (p_whatsapp, p_cidade, p_bairro, p_estado)
    ON CONFLICT (whatsapp) DO UPDATE
        SET cidade        = COALESCE(EXCLUDED.cidade, consumidor_preferencias.cidade),
            bairro        = COALESCE(EXCLUDED.bairro, consumidor_preferencias.bairro),
            estado        = COALESCE(EXCLUDED.estado, consumidor_preferencias.estado),
            atualizado_em = now();

    -- Insere o alerta específico (evita duplicatas por termo+tipo)
    INSERT INTO consumidor_alertas (whatsapp, tipo, termo, preco_alvo, ativo)
    VALUES (p_whatsapp, p_tipo, lower(trim(p_termo)), p_preco_alvo, true)
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_alerta_id;

    RETURN v_alerta_id;
END;
$$;

-- ── 7. RPC: Opt-out total (chamado pelo Orchestrator no botão Parar Alertas) ─
CREATE OR REPLACE FUNCTION optout_consumidor(p_whatsapp TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    UPDATE consumidor_preferencias
    SET optin_geral = false, atualizado_em = now()
    WHERE whatsapp = p_whatsapp;

    UPDATE consumidor_alertas
    SET ativo = false
    WHERE whatsapp = p_whatsapp;
END;
$$;
