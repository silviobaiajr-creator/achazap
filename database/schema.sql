-- ============================================================
--  AchaZap — Schema PostgreSQL (Supabase)
--  Versão: 1.1 | Março/2026
--  Execute este script no SQL Editor do seu projeto Supabase
-- ============================================================

-- Habilita extensão para geração de UUIDs (já ativa no Supabase por padrão)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";


-- ============================================================
-- TABELA: lojas
-- ============================================================
CREATE TABLE IF NOT EXISTS lojas (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  nome            VARCHAR(200)  NOT NULL,
  whatsapp        VARCHAR(20)   NOT NULL UNIQUE,  -- formato E.164: +5511999999999
  cidade          VARCHAR(100)  NOT NULL,
  bairro          VARCHAR(100)  NOT NULL,
  categoria       VARCHAR(50)   NOT NULL
                    CHECK (categoria IN (
                      'supermercado', 'farmacia', 'construcao',
                      'padaria', 'acougue', 'pet', 'outro'
                    )),
  faz_delivery    BOOLEAN       NOT NULL DEFAULT false,
  saldo_cliques   INTEGER       NOT NULL DEFAULT 0 CHECK (saldo_cliques >= 0),
  ativa           BOOLEAN       NOT NULL DEFAULT true,
  criado_em       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  atualizado_em   TIMESTAMPTZ   NOT NULL DEFAULT now()
);

COMMENT ON COLUMN lojas.saldo_cliques IS
  'Mantido automaticamente por triggers. NÃO atualizar manualmente.';
COMMENT ON COLUMN lojas.faz_delivery IS
  'true → mensagem "Quero entrega"; false → "Estou indo buscar"';


-- ============================================================
-- TABELA: usuarios
-- ============================================================
CREATE TABLE IF NOT EXISTS usuarios (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  whatsapp        VARCHAR(20)   NOT NULL UNIQUE,  -- identificador principal
  nome            VARCHAR(150),
  cidade          VARCHAR(100)  NOT NULL,
  bairro          VARCHAR(100)  NOT NULL,
  criado_em       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  atualizado_em   TIMESTAMPTZ   NOT NULL DEFAULT now()
);


-- ============================================================
-- TABELA: pacotes_cliques
-- Registra cada compra de pacote feita pelo lojista.
-- ============================================================
CREATE TABLE IF NOT EXISTS pacotes_cliques (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  loja_id          UUID          NOT NULL REFERENCES lojas(id) ON DELETE RESTRICT,
  quantidade       INTEGER       NOT NULL CHECK (quantidade > 0),
  preco_pago       NUMERIC(10,2) NOT NULL CHECK (preco_pago >= 0),
  nota_fiscal_ref  VARCHAR(100),    -- ex: Stripe charge_id, Pix txid
  validade_em      TIMESTAMPTZ,     -- NULL = sem vencimento (regra atual)
  comprado_em      TIMESTAMPTZ   NOT NULL DEFAULT now()
);

COMMENT ON TABLE pacotes_cliques IS
  'Cada linha = 1 compra de pacote. O saldo é gerenciado via trigger em lojas.saldo_cliques.';


-- ============================================================
-- TABELA: cliques_consumidos
-- IMUTÁVEL: nunca fazer UPDATE ou DELETE nesta tabela.
-- ============================================================
CREATE TABLE IF NOT EXISTS cliques_consumidos (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  loja_id         UUID          NOT NULL REFERENCES lojas(id) ON DELETE RESTRICT,
  usuario_id      UUID          NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  produto_ref     VARCHAR(250)  NOT NULL,   -- snapshot do produto buscado
  link_token      VARCHAR(100)  NOT NULL UNIQUE,  -- token do link intermediário
  debitado        BOOLEAN       NOT NULL DEFAULT true,
  motivo_skip     VARCHAR(30),              -- 'deduplicacao' se clique não foi debitado
  consumido_em    TIMESTAMPTZ   NOT NULL DEFAULT now()
);

COMMENT ON TABLE cliques_consumidos IS
  'Registro append-only de cada clique. NUNCA apagar ou alterar registros.';
COMMENT ON COLUMN cliques_consumidos.debitado IS
  'false quando skip por deduplicação (mesmo user+loja+produto < 1h)';


-- ============================================================
-- TABELA: catalogo_historico
-- APPEND-ONLY: nunca fazer UPDATE ou DELETE nesta tabela.
-- Cada alteração de preço gera um novo registro.
-- ============================================================
CREATE TABLE IF NOT EXISTS catalogo_historico (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  loja_id         UUID          NOT NULL REFERENCES lojas(id) ON DELETE RESTRICT,
  produto_nome    VARCHAR(250)  NOT NULL,
  produto_sku     VARCHAR(100),             -- código interno do ERP (opcional)
  preco           NUMERIC(10,2) NOT NULL CHECK (preco >= 0),
  unidade         VARCHAR(30)   NOT NULL DEFAULT 'un',  -- 'kg', 'cx', 'lt', 'un', etc.
  disponivel      BOOLEAN       NOT NULL DEFAULT true,
  fonte_ingestao  VARCHAR(20)   NOT NULL DEFAULT 'manual'
                    CHECK (fonte_ingestao IN ('csv', 'foto', 'audio', 'manual')),
  registrado_em   TIMESTAMPTZ   NOT NULL DEFAULT now()
  -- Sem atualizado_em: registro é imutável por design
);

COMMENT ON TABLE catalogo_historico IS
  'Append-only. Para preço atual: ORDER BY registrado_em DESC LIMIT 1. NUNCA alterar registros.';


-- ============================================================
-- TRIGGERS
-- ============================================================

-- 1. Atualiza lojas.atualizado_em automaticamente
CREATE OR REPLACE FUNCTION fn_set_atualizado_em()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.atualizado_em = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_lojas_atualizado_em
  BEFORE UPDATE ON lojas
  FOR EACH ROW EXECUTE FUNCTION fn_set_atualizado_em();

CREATE TRIGGER trg_usuarios_atualizado_em
  BEFORE UPDATE ON usuarios
  FOR EACH ROW EXECUTE FUNCTION fn_set_atualizado_em();


-- 2. Incrementa saldo_cliques quando pacote é comprado
CREATE OR REPLACE FUNCTION fn_incrementa_saldo_cliques()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE lojas
    SET saldo_cliques = saldo_cliques + NEW.quantidade
  WHERE id = NEW.loja_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_incrementa_saldo
  AFTER INSERT ON pacotes_cliques
  FOR EACH ROW EXECUTE FUNCTION fn_incrementa_saldo_cliques();


-- 3. Decrementa saldo_cliques quando clique é consumido (e debitado = true)
CREATE OR REPLACE FUNCTION fn_decrementa_saldo_cliques()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Só debita se não foi skippado por deduplicação
  IF NEW.debitado = true THEN
    UPDATE lojas
      SET saldo_cliques = saldo_cliques - 1
    WHERE id = NEW.loja_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_decrementa_saldo
  AFTER INSERT ON cliques_consumidos
  FOR EACH ROW EXECUTE FUNCTION fn_decrementa_saldo_cliques();


-- ============================================================
-- ÍNDICES (performance)
-- ============================================================

-- Busca geográfica (principal query do sistema)
CREATE INDEX IF NOT EXISTS idx_lojas_cidade_bairro
  ON lojas (cidade, bairro)
  WHERE ativa = true AND saldo_cliques > 0;

-- Busca de produtos por loja + nome (busca textual)
CREATE INDEX IF NOT EXISTS idx_catalogo_loja_produto
  ON catalogo_historico (loja_id, produto_nome, registrado_em DESC);

-- Preço mais recente por produto/loja
CREATE INDEX IF NOT EXISTS idx_catalogo_mais_recente
  ON catalogo_historico (loja_id, produto_sku, registrado_em DESC)
  WHERE disponivel = true;

-- Histórico de cliques por loja
CREATE INDEX IF NOT EXISTS idx_cliques_loja
  ON cliques_consumidos (loja_id, consumido_em DESC);

-- Deduplicação: verificar cliques recentes do mesmo user+loja+produto
CREATE INDEX IF NOT EXISTS idx_cliques_dedup
  ON cliques_consumidos (usuario_id, loja_id, produto_ref, consumido_em DESC);

-- Usuário por WhatsApp (lookup principal)
CREATE INDEX IF NOT EXISTS idx_usuarios_whatsapp
  ON usuarios (whatsapp);

-- Histórico de pacotes por loja
CREATE INDEX IF NOT EXISTS idx_pacotes_loja
  ON pacotes_cliques (loja_id, comprado_em DESC);


-- ============================================================
-- ROW LEVEL SECURITY (Supabase)
-- Ativa RLS em todas as tabelas por segurança
-- ============================================================
ALTER TABLE lojas              ENABLE ROW LEVEL SECURITY;
ALTER TABLE usuarios           ENABLE ROW LEVEL SECURITY;
ALTER TABLE pacotes_cliques    ENABLE ROW LEVEL SECURITY;
ALTER TABLE cliques_consumidos ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalogo_historico ENABLE ROW LEVEL SECURITY;

-- Por enquanto, apenas o service_role (backend) acessa tudo.
-- Policies granulares serão adicionadas na Fase 8 (painel lojista).
-- As policies abaixo bloqueiam acesso anônimo (padrão seguro):
-- (nenhuma policy = nenhum acesso via client-side Supabase)


-- ============================================================
-- DADOS INICIAIS DE TESTE (seed)
-- ============================================================

-- Loja de teste sem saldo (inativa nas buscas)
INSERT INTO lojas (nome, whatsapp, cidade, bairro, categoria, faz_delivery)
VALUES ('Mercadinho do João', '+5511911111111', 'São Paulo', 'Vila Madalena', 'supermercado', false);

-- Loja de teste com saldo e delivery
INSERT INTO lojas (nome, whatsapp, cidade, bairro, categoria, faz_delivery)
VALUES ('Farmácia Saúde Total', '+5511922222222', 'São Paulo', 'Vila Madalena', 'farmacia', true);

-- Adiciona 500 cliques para a farmácia de teste
INSERT INTO pacotes_cliques (loja_id, quantidade, preco_pago, nota_fiscal_ref)
SELECT id, 500, 149.90, 'SEED_INICIAL'
FROM lojas WHERE whatsapp = '+5511922222222';

-- Produtos de teste (catálogo inicial)
INSERT INTO catalogo_historico (loja_id, produto_nome, preco, unidade, fonte_ingestao)
SELECT id, 'Dipirona 500mg (caixa c/10)', 8.90, 'cx', 'manual'
FROM lojas WHERE whatsapp = '+5511922222222';

INSERT INTO catalogo_historico (loja_id, produto_nome, preco, unidade, fonte_ingestao)
SELECT id, 'Dipirona 500mg (caixa c/10)', 7.50, 'cx', 'manual'
FROM lojas WHERE whatsapp = '+5511922222222';
-- ^ Simula histórico: preço anterior 8.90 → atual 7.50

-- Usuário de teste
INSERT INTO usuarios (whatsapp, nome, cidade, bairro)
VALUES ('+5511999999999', 'Maria Teste', 'São Paulo', 'Vila Madalena');
