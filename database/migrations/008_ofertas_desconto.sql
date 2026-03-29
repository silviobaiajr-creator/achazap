-- =============================================================
-- AchaZap — Migration 008: Ofertas de Desconto por Ticket Mínimo
-- =============================================================

-- Tabela de ofertas de desconto
CREATE TABLE IF NOT EXISTS ofertas_desconto (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  loja_id         UUID          NOT NULL REFERENCES lojas(id) ON DELETE CASCADE,
  valor_minimo    NUMERIC(10,2) NOT NULL CHECK (valor_minimo > 0),
  percentual      NUMERIC(5,2)  NOT NULL CHECK (percentual > 0 AND percentual <= 100),
  validade        TIMESTAMPTZ   NOT NULL,
  produto_filtro  VARCHAR(250),              -- opcional: aplica só a esse produto/categoria
  ativa           BOOLEAN       NOT NULL DEFAULT true,
  criado_em       TIMESTAMPTZ   NOT NULL DEFAULT now()
);

COMMENT ON TABLE ofertas_desconto IS 'Ofertas de desconto por ticket mínimo cadastradas pelo lojista';
COMMENT ON COLUMN ofertas_desconto.produto_filtro IS 'Se nulo, aplica a toda a loja. Se preenchido (ex: "arroz"), só aplica a produtos que contêm esse termo';

-- Índices para busca
CREATE INDEX IF NOT EXISTS idx_ofertas_desconto_loja ON ofertas_desconto(loja_id) WHERE ativa = true;
CREATE INDEX IF NOT EXISTS idx_ofertas_desconto_validade ON ofertas_desconto(validade) WHERE ativa = true;
