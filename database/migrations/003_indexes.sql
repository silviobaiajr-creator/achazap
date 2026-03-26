-- =============================================================
-- AchaZap — Migration 003: Índices de Performance
-- =============================================================

-- ------------------------------------------------------------
-- lojas: busca por região e filtro de saldo ativo
-- Query: WHERE cidade = ? AND bairro = ? AND saldo_cliques > 0 AND ativa = true
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_lojas_regiao
  ON lojas (cidade, bairro)
  WHERE ativa = true AND saldo_cliques > 0;

-- ------------------------------------------------------------
-- catalogo_historico: busca full-text por produto e loja
-- Query: WHERE loja_id = ? AND produto_nome ILIKE '%arroz%' ORDER BY registrado_em DESC
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_catalogo_loja_produto
  ON catalogo_historico (loja_id, produto_nome);

-- Índice para pegar preço mais recente (ORDER BY registrado_em DESC)
CREATE INDEX IF NOT EXISTS idx_catalogo_loja_data
  ON catalogo_historico (loja_id, registrado_em DESC);

-- Full-text search para busca flexível por nome de produto
CREATE INDEX IF NOT EXISTS idx_catalogo_produto_fts
  ON catalogo_historico USING GIN (to_tsvector('portuguese', produto_nome));

-- ------------------------------------------------------------
-- cliques_consumidos: deduplicação (usuario + loja + produto < 1h)
-- Query: WHERE usuario_id = ? AND loja_id = ? AND produto_ref = ?
--        AND consumido_em > now() - interval '1 hour'
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_cliques_deduplicacao
  ON cliques_consumidos (usuario_id, loja_id, produto_ref, consumido_em DESC);

-- Busca por token para o endpoint de redirect
CREATE UNIQUE INDEX IF NOT EXISTS idx_cliques_token
  ON cliques_consumidos (link_token);

-- ------------------------------------------------------------
-- pacotes_cliques: histórico de compras por loja
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_pacotes_loja
  ON pacotes_cliques (loja_id, comprado_em DESC);

-- ------------------------------------------------------------
-- usuarios: lookup por whatsapp (identificador principal)
-- Já coberto pelo UNIQUE em whatsapp, mas INDEX explícito melhora reads
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_usuarios_whatsapp
  ON usuarios (whatsapp);
