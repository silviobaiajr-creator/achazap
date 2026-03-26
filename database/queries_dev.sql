-- =============================================================
-- AchaZap — Queries de Consulta Úteis para Desenvolvimento
-- =============================================================
-- Use no SQL Editor do Supabase para validar o schema e os dados

-- 1. Ver preço ATUAL de cada produto por loja (usando DISTINCT ON)
SELECT DISTINCT ON (loja_id, produto_nome)
  l.nome          AS loja,
  ch.produto_nome,
  ch.preco,
  ch.unidade,
  ch.disponivel,
  ch.fonte_ingestao,
  ch.registrado_em
FROM catalogo_historico ch
JOIN lojas l ON l.id = ch.loja_id
ORDER BY loja_id, produto_nome, registrado_em DESC;

-- ------------------------------------------------------------

-- 2. Histórico de preços do Arroz (análise de oferta)
SELECT
  l.nome AS loja,
  ch.preco,
  ch.registrado_em,
  CASE
    WHEN ch.preco = MIN(ch.preco) OVER (PARTITION BY ch.loja_id, ch.produto_nome)
    THEN '🔥 Menor preço histórico'
    ELSE '—'
  END AS destaque
FROM catalogo_historico ch
JOIN lojas l ON l.id = ch.loja_id
WHERE ch.produto_nome ILIKE '%arroz%'
ORDER BY ch.loja_id, ch.registrado_em;

-- ------------------------------------------------------------

-- 3. Busca por região (como a skill buscar_ofertas_por_regiao faz)
-- Parâmetros: cidade = 'Campinas', bairro = 'Cambuí', query = 'arroz'
SELECT DISTINCT ON (ch.loja_id, ch.produto_nome)
  l.nome          AS loja,
  l.faz_delivery,
  l.whatsapp,
  ch.produto_nome,
  ch.preco,
  ch.unidade,
  ch.disponivel
FROM catalogo_historico ch
JOIN lojas l ON l.id = ch.loja_id
WHERE l.cidade = 'Campinas'
  AND l.bairro = 'Cambuí'
  AND l.saldo_cliques > 0
  AND l.ativa = true
  AND ch.disponivel = true
  AND to_tsvector('portuguese', ch.produto_nome) @@ plainto_tsquery('portuguese', 'arroz')
ORDER BY ch.loja_id, ch.produto_nome, ch.registrado_em DESC;

-- ------------------------------------------------------------

-- 4. Verificar deduplicação (cliques da última hora por usuário+loja+produto)
SELECT
  u.nome AS usuario,
  l.nome AS loja,
  cc.produto_ref,
  cc.consumido_em,
  (now() - cc.consumido_em) AS tempo_desde_clique
FROM cliques_consumidos cc
JOIN usuarios u ON u.id = cc.usuario_id
JOIN lojas    l ON l.id = cc.loja_id
WHERE cc.consumido_em > now() - interval '1 hour'
ORDER BY cc.consumido_em DESC;

-- ------------------------------------------------------------

-- 5. Dashboard: saldo de cliques por loja
SELECT
  nome,
  saldo_cliques,
  ativa,
  categoria,
  cidade || '/' || bairro AS regiao
FROM lojas
ORDER BY saldo_cliques DESC;
