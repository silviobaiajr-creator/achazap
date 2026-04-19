import { logger } from './logger.js';
import { supabaseAdmin } from './supabase.js';
import { enviarAlertaDono } from './whatsapp.js';
import { env } from '../config.js';
export { enviarLogAuditoria } from './audit.js';

/**
 * Função central para logar erros críticos.
 * 1. Registra no Pino (Console/CloudWatch)
 * 2. Salva no Supabase (Persistência para auditoria)
 * 3. Envia para o WhatsApp do Dono (Alerta imediato)
 */
export async function logErroCritico(args: {
    origem: 'PROCESSOR' | 'WEBHOOK' | 'GLOBAL' | 'DB' | 'AI' | 'FLUXO_TESTE';
    whatsapp?: string;
    mensagem: string;
    err?: any;
    contexto?: any;
    nivel?: 'FATAL' | 'WARN';
}) {
    const { origem, whatsapp, mensagem, err, nivel = 'WARN' } = args;
    let contexto = args.contexto || {};
    
    // 1. Snapshot Automático de Estado de Máquina (Prevenção de Loop Circular)
    let historicoCurto: any[] = [];
    let stateSnapshot: any = null;

    if (whatsapp) {
        try {
            // Dynamic import para lerContexto no Redis em Memória
            const redisModule = await import('./redis-cloud.js');
            stateSnapshot = await redisModule.lerContexto(whatsapp);
            if (stateSnapshot) contexto.estado_sessao = stateSnapshot;
            
            // Push das últimas 3 mensagens para entender como a IA "quebrou"
            const { data: hist } = await supabaseAdmin.from('historico_mensagens')
                .select('role, content')
                .eq('whatsapp', whatsapp)
                .order('created_at', { ascending: false })
                .limit(3);
                
            if (hist && hist.length > 0) {
                historicoCurto = hist.reverse();
                contexto.historico_recente = historicoCurto;
            }
        } catch (e) {
            logger.warn({ msg: 'Falha ao anexar contexto rico no logErroCritico', error: e });
        }
    }

    // 2. Log Estruturado
    logger.error({ 
        origem, 
        nivel,
        from: whatsapp, 
        err: err?.message || err, 
        contexto 
    }, `[${origem}] ${mensagem}`);

    // 3. Persistência no Banco (Fire & Forget interno para não travar o fluxo)
    supabaseAdmin.from('logs_erro').insert([{
        origem,
        whatsapp,
        mensagem,
        nivel,
        stack_trace: err?.stack || String(err),
        contexto: Object.keys(contexto).length > 0 ? contexto : null
    }]).then(({ error }) => {
        if (error) logger.error({ error }, '❌ Falha ao salvar log_erro no Supabase');
    });

    // 4. Alerta Rico no WhatsApp do Dono
    let formatAlert = `🚨 *ACHAZAP [${nivel}]*\n*Origem:* ${origem}${whatsapp ? `\n*Lojista:* ${whatsapp}` : ''}\n\n*Erro:* ${mensagem}`;
    
    if (stateSnapshot?.estado) {
        formatAlert += `\n\n*Estado Atual:* ${stateSnapshot.estado}\n`;
        if (stateSnapshot.acao) formatAlert += `*Ação:* ${stateSnapshot.acao}`;
    }

    if (historicoCurto.length > 0) {
        formatAlert += `\n\n*Últimas Mensagens:*`;
        historicoCurto.forEach((h: any) => {
            const shortC = h.content.substring(0, 50).replace(/\n/g, ' ');
            formatAlert += `\n- [${h.role === 'user' ? 'Lojista' : 'Robô'}] "${shortC}${h.content.length > 50 ? '...' : ''}"`;
        });
    }

    await enviarAlertaDono(formatAlert, whatsapp, origem, nivel);
}

