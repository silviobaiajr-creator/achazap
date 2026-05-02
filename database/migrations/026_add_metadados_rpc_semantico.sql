-- Migration 026: Adiciona metadados ao retorno do buscar_ofertas_semantico

DROP FUNCTION IF EXISTS public.buscar_ofertas_semantico(text, vector, float, int);
CREATE OR REPLACE FUNCTION public.buscar_ofertas_semantico(
    p_estado text,
    p_query_embedding vector(768),
    p_match_threshold float DEFAULT 0.6,
    p_limit int DEFAULT 30
)
RETURNS TABLE (
    id uuid,
    loja_id uuid,
    loja_nome text,
    whatsapp_loja text,
    faz_delivery boolean,
    plano varchar(20),
    produto_nome text,
    produto_sku text,
    preco_atual numeric,
    unidade text,
    oferta_expira_em timestamptz,
    metadados jsonb,
    registrado_em timestamptz,
    similarity float
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        c.id,
        c.loja_id,
        l.nome::text AS loja_nome,
        l.whatsapp::text AS whatsapp_loja,
        l.faz_delivery,
        l.plano,
        c.produto_nome::text,
        COALESCE(c.produto_sku, '')::text AS produto_sku,
        c.preco AS preco_atual,
        c.unidade::text,
        c.oferta_expira_em,
        c.metadados,
        c.atualizado_em AS registrado_em,
        1 - (c.embedding <=> p_query_embedding) AS similarity
    FROM public.catalogo_ativo c
    JOIN public.lojas l ON l.id = c.loja_id
    WHERE 
        c.disponivel = true
        AND l.ativa = true
        AND l.estado = p_estado
        AND 1 - (c.embedding <=> p_query_embedding) > p_match_threshold
    ORDER BY 
        (l.plano = 'premium') DESC,
        (c.oferta_expira_em > now()) DESC,
        (1 - (c.embedding <=> p_query_embedding)) DESC,
        RANDOM()
    LIMIT p_limit;
END;
$$;
