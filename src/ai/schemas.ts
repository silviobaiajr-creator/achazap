/**
 * Schemas Zod para validação de todos os outputs do Gemini.
 * Garante tipagem segura e evita crashes por JSON inesperado (Sprint 2 #4, D1).
 */
import { z } from 'zod';

// ─── Extração de Produto (processarDadosProduto) ─────────────────────────────

export const ProdutoExtraidoSchema = z.object({
    incompleto:      z.boolean().default(false),
    ruido_detectado: z.boolean().default(false),
    falta:           z.enum(['preco', 'nome', 'unidade']).optional(),
    nome:            z.string().max(250).nullable().default(null),
    preco:           z.number().nullable().default(null),
    unidade:         z.string().max(30).nullable().default(null),
    precisa_confirmacao: z.boolean().default(false),
    sugestao:        z.string().max(250).nullable().default(null),
});

export type ProdutoExtraido = z.infer<typeof ProdutoExtraidoSchema>;

// ─── Busca de Similares via Gemini (buscarProdutosSimilares) ─────────────────

export const IndicesSimilaresSchema = z.array(z.number().int().positive());

// ─── Fallback NLP (tradução de intenção coloquial) ───────────────────────────

export const NLPEscolhaSchema = z.object({
    escolha:  z.number().int(),
    cancelar: z.boolean().default(false),
});

export type NLPEscolha = z.infer<typeof NLPEscolhaSchema>;

// ─── Detecção de Fuga NLP ────────────────────────────────────────────────────

export const FugaNLPSchema = z.object({
    intencao_fuga: z.boolean(),
});

// ─── Multimodal (OCR de imagem / transcrição de áudio) ───────────────────────

export const MultimodalExtraidoSchema = z.union([
    z.object({
        legibilidade_baixa: z.literal(true),
    }),
    z.object({
        multiplos_produtos: z.literal(true),
    }),
    z.object({
        ruido_detectado: z.literal(true),
    }),
    z.object({
        legibilidade_baixa: z.boolean().default(false),
        multiplos_produtos:  z.boolean().default(false),
        ruido_detectado:     z.boolean().default(false),
        nome:    z.string().max(250).nullable(),
        preco:   z.number().nullable(),
        unidade: z.string().max(30).nullable(),
    }),
]);

export type MultimodalExtraido = z.infer<typeof MultimodalExtraidoSchema>;

// ─── Oferta de Desconto ──────────────────────────────────────────────────────

export const OfertaExtraidaSchema = z.object({
    valor_minimo:  z.number().positive(),
    percentual:    z.number().min(0).max(100),
    validade:      z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data deve estar no formato YYYY-MM-DD'),
    produto_filtro: z.string().nullable().optional(),
});

export type OfertaExtraida = z.infer<typeof OfertaExtraidaSchema>;

// ─── Helper: parse seguro (nunca lança exceção) ──────────────────────────────

export function parseSafe<T>(schema: z.ZodType<T>, raw: string, fallback: T): T {
    try {
        return schema.parse(JSON.parse(raw));
    } catch (err) {
        return fallback;
    }
}
