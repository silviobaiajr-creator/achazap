-- Migration 019: Motor Semântico (pgvector)
-- Habilita a extensão pgvector e estrutura a busca vetorial no catálogo.

-- 1. Habilitar a extensão
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Adicionar coluna vetorial à tabela catalogo_ativo
-- O Gemini 'gemini-embedding-001' produz vetores de 768 dimensões.
ALTER TABLE public.catalogo_ativo
ADD COLUMN IF NOT EXISTS embedding vector(768);

-- 3. Criar índice HNSW para busca ultramais rápida (Cosine Distance)
CREATE INDEX IF NOT EXISTS catalogo_ativo_embedding_idx 
ON public.catalogo_ativo 
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- 4. Criar RPC especializado para a Busca Semântica do Consumidor
-- Recebe o embedding do termo do usuário e filtra por estado
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
    produto_nome text,
    produto_sku text,
    preco_atual numeric,
    unidade text,
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
        c.produto_nome::text,
        ''::text AS produto_sku,
        c.preco AS preco_atual,
        c.unidade::text,
        c.atualizado_em AS registrado_em,
        -- Cosine similarity: 1 - Cosine Distance
        1 - (c.embedding <=> p_query_embedding) AS similarity
    FROM public.catalogo_ativo c
    JOIN public.lojas l ON l.id = c.loja_id
    WHERE 
        c.disponivel = true
        AND l.ativa = true
        AND l.estado = p_estado
        -- Apenas retornar resultados com similaridade acima do limite
        AND 1 - (c.embedding <=> p_query_embedding) > p_match_threshold
    ORDER BY c.embedding <=> p_query_embedding
    LIMIT p_limit;
END;
$$;

-- 5. Criar RPC especializado para Deduplicação Interna do Lojista
-- Útil ao enviar uma imagem para saber se o produto já existe no estoque daquela loja
DROP FUNCTION IF EXISTS public.buscar_similares_semantico(uuid, vector, float, int);
CREATE OR REPLACE FUNCTION public.buscar_similares_semantico(
    p_loja_id uuid,
    p_query_embedding vector(768),
    p_match_threshold float DEFAULT 0.7,
    p_limit int DEFAULT 5
)
RETURNS TABLE (
    id uuid,
    produto_nome text,
    preco numeric,
    unidade text,
    similarity float
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        c.id,
        c.produto_nome,
        c.preco,
        c.unidade,
        1 - (c.embedding <=> p_query_embedding) AS similarity
    FROM public.catalogo_ativo c
    WHERE 
        c.loja_id = p_loja_id
        AND c.disponivel = true
        AND 1 - (c.embedding <=> p_query_embedding) > p_match_threshold
    ORDER BY c.embedding <=> p_query_embedding
    LIMIT p_limit;
END;
$$;
