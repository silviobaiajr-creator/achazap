CREATE OR REPLACE FUNCTION get_insights_precificacao()
RETURNS TABLE (
    loja_id UUID,
    whatsapp VARCHAR,
    loja_nome VARCHAR,
    produto_id UUID,
    produto_nome VARCHAR,
    preco_loja NUMERIC,
    preco_medio NUMERIC,
    desvio_padrao NUMERIC,
    cliques BIGINT
) LANGUAGE sql STABLE AS $$
    WITH cliques_recentes AS (
        SELECT loja_id, produto_ref, COUNT(*) as qtd_cliques
        FROM cliques_consumidos
        WHERE consumido_em >= NOW() - INTERVAL '7 days'
        GROUP BY loja_id, produto_ref
    ),
    produtos_acima_media AS (
        SELECT 
            ca.id as produto_id,
            ca.produto_nome,
            ca.preco as preco_loja,
            ca.loja_id,
            l.whatsapp,
            l.nome as loja_nome,
            v.preco_medio,
            v.desvio_padrao
        FROM vw_catalogo_ativo ca
        JOIN lojas l ON ca.loja_id = l.id
        JOIN v_estatisticas_bairro v 
          ON l.cidade = v.cidade 
          AND l.bairro = v.bairro 
          AND ca.produto_nome = v.produto_nome
          AND ca.unidade = v.unidade
        -- Preço > 5% E acima de meio desvio padrão
        WHERE ca.preco > (v.preco_medio * 1.05) 
          AND ca.preco > (v.preco_medio + (v.desvio_padrao * 0.5))
    )
    SELECT 
        p.loja_id,
        p.whatsapp,
        p.loja_nome,
        p.produto_id,
        p.produto_nome,
        p.preco_loja,
        p.preco_medio,
        p.desvio_padrao,
        COALESCE(c.qtd_cliques, 0) as cliques
    FROM produtos_acima_media p
    LEFT JOIN cliques_recentes c 
      ON p.loja_id = c.loja_id AND p.produto_nome = c.produto_ref
    WHERE COALESCE(c.qtd_cliques, 0) < 5;
$$;
