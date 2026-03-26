-- =============================================================
-- AchaZap — Seed: Dados de Teste para Desenvolvimento
-- =============================================================
-- Execute APÓS as migrations 001, 002 e 003
-- ATENÇÃO: Apenas para ambiente de desenvolvimento/staging

-- Limpa dados anteriores de seed (ordem importa por FK)
TRUNCATE catalogo_historico, cliques_consumidos, pacotes_cliques, usuarios, lojas
  CASCADE;

-- =============================================================
-- LOJAS de teste (2 cidades, 3 bairros)
-- =============================================================
INSERT INTO lojas (id, nome, whatsapp, cidade, bairro, categoria, faz_delivery, saldo_cliques) VALUES
  -- Campinas / Cambuí
  ('11111111-0000-0000-0000-000000000001', 'Supermercado Cambuí', '+5519988880001', 'Campinas', 'Cambuí', 'supermercado', true,  500),
  ('11111111-0000-0000-0000-000000000002', 'Farmácia Saúde Total', '+5519988880002', 'Campinas', 'Cambuí', 'farmacia',     false, 200),
  -- Campinas / Barão Geraldo
  ('11111111-0000-0000-0000-000000000003', 'Constrular BG',       '+5519988880003', 'Campinas', 'Barão Geraldo', 'construcao', false, 100),
  -- São Paulo / Vila Madalena
  ('11111111-0000-0000-0000-000000000004', 'MiniBox Vila Mada',   '+5511988880004', 'São Paulo', 'Vila Madalena', 'supermercado', true, 300),
  -- Loja com saldo zerado (NÃO deve aparecer nas buscas)
  ('11111111-0000-0000-0000-000000000005', 'Mercado Falido',      '+5519988880005', 'Campinas', 'Cambuí', 'supermercado', false, 0);

-- NOTA: saldo_cliques foi inserido diretamente no seed para simplificar.
-- Em produção, o saldo é sempre gerenciado pelos triggers via pacotes_cliques.

-- =============================================================
-- USUÁRIOS de teste
-- =============================================================
INSERT INTO usuarios (id, whatsapp, nome, cidade, bairro) VALUES
  ('22222222-0000-0000-0000-000000000001', '+5519977770001', 'Maria Silva',   'Campinas',  'Cambuí'),
  ('22222222-0000-0000-0000-000000000002', '+5511977770002', 'João Pereira',  'São Paulo', 'Vila Madalena'),
  ('22222222-0000-0000-0000-000000000003', '+5519977770003', 'Ana Costa',     'Campinas',  'Barão Geraldo');

-- =============================================================
-- CATÁLOGO HISTÓRICO (preços com histórico para testes)
-- =============================================================

-- Supermercado Cambuí — Arroz (3 registros históricos → preço atual = R$22,90)
INSERT INTO catalogo_historico (loja_id, produto_nome, produto_sku, preco, unidade, disponivel, fonte_ingestao, registrado_em) VALUES
  ('11111111-0000-0000-0000-000000000001', 'Arroz tipo 1 5kg',  'ARR-5KG', 25.90, 'sc',  true,  'csv',    now() - interval '90 days'),
  ('11111111-0000-0000-0000-000000000001', 'Arroz tipo 1 5kg',  'ARR-5KG', 24.50, 'sc',  true,  'csv',    now() - interval '45 days'),
  ('11111111-0000-0000-0000-000000000001', 'Arroz tipo 1 5kg',  'ARR-5KG', 22.90, 'sc',  true,  'csv',    now() - interval '2 days'),
  -- Feijão (preço atual subiu → NÃO é a menor oferta)
  ('11111111-0000-0000-0000-000000000001', 'Feijão carioca 1kg','FEJ-1KG', 7.50,  'un',  true,  'csv',    now() - interval '60 days'),
  ('11111111-0000-0000-0000-000000000001', 'Feijão carioca 1kg','FEJ-1KG', 9.90,  'un',  true,  'csv',    now() - interval '1 day'),
  -- Produto indisponível
  ('11111111-0000-0000-0000-000000000001', 'Azeite extra virgem 500ml', 'AZT-500', 32.00, 'un', false, 'foto', now() - interval '5 days');

-- Farmácia Saúde Total
INSERT INTO catalogo_historico (loja_id, produto_nome, produto_sku, preco, unidade, disponivel, fonte_ingestao, registrado_em) VALUES
  ('11111111-0000-0000-0000-000000000002', 'Dipirona 500mg 20cp', 'DIP-20',  8.90, 'cx', true, 'manual', now() - interval '10 days'),
  ('11111111-0000-0000-0000-000000000002', 'Dipirona 500mg 20cp', 'DIP-20',  7.50, 'cx', true, 'csv',    now() - interval '1 day'),
  ('11111111-0000-0000-0000-000000000002', 'Álcool gel 70% 500ml','ALC-500', 12.90,'un', true, 'foto',   now() - interval '3 days');

-- Constrular BG
INSERT INTO catalogo_historico (loja_id, produto_nome, produto_sku, preco, unidade, disponivel, fonte_ingestao, registrado_em) VALUES
  ('11111111-0000-0000-0000-000000000003', 'Cimento CP-II 50kg',    'CIM-50', 42.00,'sc',  true, 'csv',   now() - interval '7 days'),
  ('11111111-0000-0000-0000-000000000003', 'Tinta acrílica branca 18L','TIN-18', 189.90,'lt', true,'audio', now() - interval '2 days');

-- MiniBox São Paulo
INSERT INTO catalogo_historico (loja_id, produto_nome, produto_sku, preco, unidade, disponivel, fonte_ingestao, registrado_em) VALUES
  ('11111111-0000-0000-0000-000000000004', 'Arroz tipo 1 5kg',   'ARR-5KG', 23.90, 'sc', true, 'csv', now() - interval '3 days'),
  ('11111111-0000-0000-0000-000000000004', 'Leite integral 1L',  'LEI-1L',  5.49,  'lt', true, 'csv', now() - interval '1 day');

-- =============================================================
-- PACOTES DE CLIQUES (histórico de compras — seed não usa triggers)
-- =============================================================
INSERT INTO pacotes_cliques (loja_id, quantidade, preco_pago, nota_fiscal_ref, comprado_em) VALUES
  ('11111111-0000-0000-0000-000000000001', 500, 249.90, 'STRIPE-ch_test_001', now() - interval '30 days'),
  ('11111111-0000-0000-0000-000000000002', 200, 119.90, 'PIX-txid-test-002',  now() - interval '15 days'),
  ('11111111-0000-0000-0000-000000000003', 100, 69.90,  'STRIPE-ch_test_003', now() - interval '7 days'),
  ('11111111-0000-0000-0000-000000000004', 500, 249.90, 'PIX-txid-test-004',  now() - interval '5 days');

-- NOTA: saldo_cliques já foi inserido diretamente nas lojas neste seed.
-- Em produção real, os triggers calculam o saldo automaticamente.

-- =============================================================
-- Verificação rápida pós-seed
-- =============================================================
SELECT
  nome,
  saldo_cliques,
  ativa,
  CASE WHEN saldo_cliques > 0 THEN '✅ Aparece nas buscas' ELSE '🚫 Bloqueada' END AS status
FROM lojas
ORDER BY nome;
