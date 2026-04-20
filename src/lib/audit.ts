/**
 * Módulo de Auditoria de Fluxo — sem dependência circular.
 * Importado por logger.ts e monitor.ts sem risco de loop.
 * Grava no Supabase logs_dev para TODOS os usuários — o campo
 * `whatsapp` armazena o número real do usuário para diagnóstico.
 */
import { supabaseAdmin } from './supabase.js';

export function enviarLogAuditoria(args: {
    whatsapp: string;
    nivel: 'info' | 'warn' | 'error';
    contexto: string;
    mensagem: string;
    dados?: Record<string, unknown>;
}) {
    // Grava para qualquer usuário — fundamental para diagnosticar fluxos de consumidores.
    supabaseAdmin.from('logs_dev').insert([{
        whatsapp: args.whatsapp,
        nivel:    args.nivel,
        contexto: args.contexto,
        mensagem: args.mensagem,
        dados:    args.dados ?? null,
        created_at: new Date().toISOString()
    }]).then(({ error }) => {
        if (error) console.warn('[Audit] Falha ao salvar log_dev:', error.message);
    });
}
