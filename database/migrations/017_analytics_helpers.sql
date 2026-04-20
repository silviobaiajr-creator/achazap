-- =============================================================
-- AchaZap — Migration 017: Estatísticas, Insights & Thresholds
-- =============================================================

-- View Materializada (ou View Simples) para calcular estatísticas por categoria, bairro e cidade.
-- Não materializada por ora para manter real-time, mas em prod com >1mi rows compensa materializar
CREATE OR REPLACE VIEW v_estatisticas_bairro AS
WITH precos_com_filtro AS (
    SELECT 
        l.cidade,
        l.bairro,
        c.produto_nome,
        c.preco,
        c.unidade
    FROM vw_catalogo_ativo c
    JOIN lojas l ON l.id = c.loja_id
    WHERE c.preco > 0
)
SELECT 
    cidade,
    bairro,
    produto_nome,
    unidade,
    COUNT(*) as amostra,
    AVG(preco) as preco_medio,
    MIN(preco) as preco_minimo,
    MAX(preco) as preco_maximo,
    -- Desvio padrão para cálculo do threshold elástico (permite tolerar maior margem se desvio for alto)
    COALESCE(STDDEV_POP(preco), 0) as desvio_padrao
FROM precos_com_filtro
GROUP BY cidade, bairro, produto_nome, unidade;

COMMENT ON VIEW v_estatisticas_bairro IS 'Agregação de preços do catálogo ativo para insights de competitividade da loja.';

-- Nova tabela para registrar os insights enviados aos lojistas (para não repeti-los diariamente)
CREATE TABLE IF NOT EXISTS loja_insights_enviados (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    loja_id UUID NOT NULL REFERENCES lojas(id) ON DELETE CASCADE,
    tipo VARCHAR(50) NOT NULL, -- 'PRECO_ALTO', 'SEM_OFERTAS', etc.
    produto_nome VARCHAR(250), -- se aplicável ao produto individual
    enviado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_insights_loja ON loja_insights_enviados(loja_id, tipo);
