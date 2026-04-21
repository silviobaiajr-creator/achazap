-- Re-definindo o RPC de busca similares para garantir tipos exatos
DROP FUNCTION IF EXISTS public.buscar_similares_semantico(uuid, vector, float, int);

CREATE OR REPLACE FUNCTION public.buscar_similares_semantico(
    p_loja_id uuid,
    p_query_embedding vector(768),
    p_match_threshold float DEFAULT 0.6,
    p_limit int DEFAULT 10
)
RETURNS TABLE (
    id uuid,
    produto_nome text,
    preco numeric,
    unidade text,
    similarity float8
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        c.id,
        c.produto_nome::text,
        c.preco::numeric,
        c.unidade::text,
        (1 - (c.embedding <=> p_query_embedding))::float8 AS similarity
    FROM public.catalogo_ativo c
    WHERE 
        c.loja_id = p_loja_id
        AND c.disponivel = true
        AND c.embedding IS NOT NULL
        AND 1 - (c.embedding <=> p_query_embedding) > p_match_threshold
    ORDER BY c.embedding <=> p_query_embedding
    LIMIT p_limit;
END;
$$;
