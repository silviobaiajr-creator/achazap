/**
 * Módulo de Auditoria de Fluxo — sem dependência circular.
 * Importado por logger.ts e monitor.ts sem risco de loop.
 * Grava no Supabase logs_dev apenas se o número for o Owner.
 */
import { supabaseAdmin } from './supabase.js';

export function enviarLogAuditoria(args: {
    whatsapp: string;
    nivel: 'info' | 'warn' | 'error';
    contexto: string;
    mensagem: string;
    dados?: Record<string, unknown>;
}) {
    const ownerNumber = process.env.ACHAZAP_OWNER_NUMBER;
    if (!ownerNumber || args.whatsapp !== ownerNumber) return; // ignora usuários reais

    supabaseAdmin.from('logs_dev').insert([{
        whatsapp: args.whatsapp,
        nivel:    args.nivel,
        contexto: args.contexto,
        mensagem: args.mensagem,
        dados:    args.dados ?? null,
    }]).then(({ error }) => {
        if (error) console.warn('[Audit] Falha ao salvar log_dev:', error.message);
    });
}
