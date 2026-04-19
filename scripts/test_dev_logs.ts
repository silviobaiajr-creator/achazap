import 'dotenv/config';
import { enviarLogAuditoria } from '../src/lib/monitor.js';
import { env } from '../src/config.js';

async function rodarTeste() {
    const ownerNumber = env.ACHAZAP_OWNER_NUMBER!;
    console.log(`\n🧪 Simulando fluxo completo do Owner (${ownerNumber})...\n`);

    // Simula a trilha de um lojista mandando uma foto do catálogo
    enviarLogAuditoria({ whatsapp: ownerNumber, nivel: 'info', contexto: 'WEBHOOK', mensagem: '[Webhook] Mensagem recebida', dados: { type: 'image', from: ownerNumber } });
    enviarLogAuditoria({ whatsapp: ownerNumber, nivel: 'info', contexto: 'PROCESSOR', mensagem: '[Processor] Iniciando job pg-boss', dados: { jobId: 'job-teste-123' } });
    enviarLogAuditoria({ whatsapp: ownerNumber, nivel: 'info', contexto: 'ORCHESTRATOR', mensagem: '[Orquestrador] Estado atual do lojista: IDLE' });
    enviarLogAuditoria({ whatsapp: ownerNumber, nivel: 'info', contexto: 'ORCHESTRATOR', mensagem: '[Orquestrador] Mídia recebida — enviando para Gemini processar' });
    enviarLogAuditoria({ whatsapp: ownerNumber, nivel: 'warn', contexto: 'ORCHESTRATOR', mensagem: '[Proteção] Anti-spam ativo — segunda imagem bloqueada', dados: { ttl: 10 } });
    enviarLogAuditoria({ whatsapp: ownerNumber, nivel: 'info', contexto: 'ORCHESTRATOR', mensagem: '[Gemini] Extração concluída: 3 produtos detectados' });
    enviarLogAuditoria({ whatsapp: ownerNumber, nivel: 'info', contexto: 'ORCHESTRATOR', mensagem: '[Orchestrator] Aguardando confirmação do lojista' });

    // Pequena espera para dar tempo das promessas fire-and-forget chegarem ao Supabase
    await new Promise(r => setTimeout(r, 2000));

    console.log('✅ 7 eventos de auditoria enviados ao Supabase!\n');
    console.log('👉 Aguarde 3 segundos e rode: npx tsx scripts/diagnostics.ts\n');
    process.exit(0);
}

rodarTeste();
