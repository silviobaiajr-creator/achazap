-- =============================================================
-- AchaZap — Migration 001: Schema Inicial
-- Banco: PostgreSQL (Supabase)
-- Data: Março/2026
-- =============================================================
-- Execute no SQL Editor do Supabase ou via psql

-- Garante que a extensão uuid está ativa (padrão no Supabase)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =============================================================
-- TABELA: lojas
-- =============================================================
CREATE TABLE IF NOT EXISTS lojas (
  id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  nome           VARCHAR(200)  NOT NULL,
  whatsapp       VARCHAR(20)   NOT NULL UNIQUE,        -- formato E.164: +5511999999999
  cidade         VARCHAR(100)  NOT NULL,
  bairro         VARCHAR(100)  NOT NULL,
  categoria      VARCHAR(50)   NOT NULL
                   CHECK (categoria IN (
                     'supermercado','farmacia','construcao',
                     'padaria','acougue','hortifruti','outro'
                   )),
  faz_delivery   BOOLEAN       NOT NULL DEFAULT false,
  saldo_cliques  INTEGER       NOT NULL DEFAULT 0
                   CHECK (saldo_cliques >= 0),          -- nunca negativo
  ativa          BOOLEAN       NOT NULL DEFAULT true,
  criado_em      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  atualizado_em  TIMESTAMPTZ   NOT NULL DEFAULT now()
);

COMMENT ON TABLE  lojas IS 'Cadastro das lojas parceiras do AchaZap';
COMMENT ON COLUMN lojas.faz_delivery  IS 'true → mensagem "quero entrega" | false → "vou buscar"';
COMMENT ON COLUMN lojas.saldo_cliques IS 'Mantido por trigger. Não alterar manualmente.';
COMMENT ON COLUMN lojas.whatsapp IS 'Número E.164 ex: +5519999999999';

-- =============================================================
-- TABELA: usuarios
-- =============================================================
CREATE TABLE IF NOT EXISTS usuarios (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  whatsapp      VARCHAR(20)   NOT NULL UNIQUE,          -- identificador principal
  nome          VARCHAR(150),
  cidade        VARCHAR(100)  NOT NULL,
  bairro        VARCHAR(100)  NOT NULL,
  criado_em     TIMESTAMPTZ   NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ   NOT NULL DEFAULT now()
);

COMMENT ON TABLE usuarios IS 'Moradores que interagem com o AchaZap via WhatsApp';

-- =============================================================
-- TABELA: pacotes_cliques
-- =============================================================
CREATE TABLE IF NOT EXISTS pacotes_cliques (
  id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  loja_id        UUID          NOT NULL REFERENCES lojas(id) ON DELETE RESTRICT,
  quantidade     INTEGER       NOT NULL CHECK (quantidade > 0),
  preco_pago     NUMERIC(10,2) NOT NULL CHECK (preco_pago >= 0),  -- histórico em R$
  nota_fiscal_ref VARCHAR(100),                                    -- ex: Stripe charge_id
  comprado_em    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  validade_em    TIMESTAMPTZ                                       -- NULL = sem vencimento
);

COMMENT ON TABLE  pacotes_cliques IS 'Compras de pacote de cliques pelos lojistas (imutável)';
COMMENT ON COLUMN pacotes_cliques.preco_pago     IS 'Valor histórico em R$. Plataforma NÃO guarda saldo financeiro.';
COMMENT ON COLUMN pacotes_cliques.nota_fiscal_ref IS 'Referência externa do pagamento (ex: Stripe, Pix)';

-- =============================================================
-- TABELA: cliques_consumidos
-- Ciclo de vida: IA cria com debitado=false → usuário clica → /r?token atualiza para debitado=true
-- =============================================================
CREATE TABLE IF NOT EXISTS cliques_consumidos (
  id           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  loja_id      UUID          NOT NULL REFERENCES lojas(id)    ON DELETE RESTRICT,
  usuario_id   UUID          NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  produto_ref  VARCHAR(200)  NOT NULL,              -- snapshot nome do produto
  link_token   VARCHAR(100)  NOT NULL UNIQUE,        -- token único do link /r?token=
  link_gerado  TEXT,                                 -- URL wa.me final (preenchida ao gerar)
  debitado     BOOLEAN       NOT NULL DEFAULT false, -- false=pendente | true=clique efetivado
  motivo_skip  VARCHAR(50),                          -- 'deduplicacao' | null
  consumido_em TIMESTAMPTZ   NOT NULL DEFAULT now()
);

COMMENT ON TABLE  cliques_consumidos IS 'Ledger imutável de cliques debitados. NUNCA fazer UPDATE/DELETE.';
COMMENT ON COLUMN cliques_consumidos.link_token IS 'Token único do link /r?token= gerado pela IA';

-- =============================================================
-- TABELA: catalogo_historico  (append-only — nunca atualizar preços)
-- =============================================================
CREATE TABLE IF NOT EXISTS catalogo_historico (
  id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  loja_id        UUID          NOT NULL REFERENCES lojas(id) ON DELETE RESTRICT,
  produto_nome   VARCHAR(250)  NOT NULL,
  produto_sku    VARCHAR(100),             -- código ERP da loja (opcional)
  preco          NUMERIC(10,2) NOT NULL CHECK (preco >= 0),
  unidade        VARCHAR(30)   NOT NULL DEFAULT 'un'
                   CHECK (unidade IN ('un','kg','lt','cx','pct','sc','frd','bd','outro')),
  disponivel     BOOLEAN       NOT NULL DEFAULT true,
  fonte_ingestao VARCHAR(20)   NOT NULL
                   CHECK (fonte_ingestao IN ('csv','foto','audio','manual')),
  registrado_em  TIMESTAMPTZ   NOT NULL DEFAULT now()
  -- SEM atualizado_em: registro é imutável por design de negócio
);

COMMENT ON TABLE  catalogo_historico IS 'Histórico append-only de preços. NUNCA fazer UPDATE/DELETE de preços antigos.';
COMMENT ON COLUMN catalogo_historico.registrado_em IS 'Preço atual = ORDER BY registrado_em DESC LIMIT 1';
