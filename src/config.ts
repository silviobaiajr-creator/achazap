/**
 * Validação de variáveis de ambiente no boot.
 * Falha rápido (fail-fast) com mensagem descritiva se algo faltar.
 * Exporta `env` tipado para uso em todo o projeto.
 */
import { z } from 'zod';

const EnvSchema = z.object({
    // Servidor
    PORT: z.coerce.number().default(3000),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    BASE_URL: z.string().url().optional(),

    // WhatsApp Business API
    WHATSAPP_ACCESS_TOKEN: z.string().min(10, 'WHATSAPP_ACCESS_TOKEN inválido ou ausente'),
    WHATSAPP_PHONE_NUMBER_ID: z.string().min(5, 'WHATSAPP_PHONE_NUMBER_ID inválido ou ausente'),
    WHATSAPP_VERIFY_TOKEN: z.string().min(5, 'WHATSAPP_VERIFY_TOKEN inválido ou ausente'),
    WHATSAPP_APP_SECRET: z.string().optional().default(''),

    // Google Gemini
    GEMINI_API_KEY: z.string().min(10, 'GEMINI_API_KEY inválida ou ausente'),

    // Supabase
    SUPABASE_URL: z.string().url('SUPABASE_URL deve ser uma URL válida'),
    SUPABASE_SECRET_KEY: z.string().min(10, 'SUPABASE_SECRET_KEY inválida ou ausente'),

    // Redis (único — estado + BullMQ)
    REDIS_URL: z.string().min(10, 'REDIS_URL inválida ou ausente'),
});

function validarEnv() {
    const resultado = EnvSchema.safeParse(process.env);

    if (!resultado.success) {
        console.error('\n❌ ERRO CRÍTICO: Variáveis de ambiente inválidas ou ausentes:\n');
        resultado.error.issues.forEach((issue) => {
            console.error(`  • ${issue.path.join('.')}: ${issue.message}`);
        });
        console.error('\nVerifique o arquivo .env e reinicie o servidor.\n');
        process.exit(1);
    }

    return resultado.data;
}

export const env = validarEnv();
