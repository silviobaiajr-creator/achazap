import 'dotenv/config';
import { supabaseAdmin } from '../src/lib/supabase.js';

/**
 * Script de Diagnóstico para uso exclusivo do AchaZap AI (Antigravity).
 * Este script entra no banco de dados e traz os erros e as mensagens do usuário
 * para que a inteligência artificial não precise pedir os logs do Render ao desenvolvedor.
 */
async function rodarDiagnostico(telefoneDono: string) {
    console.log(`\n🔍 Iniciando diagnóstico para o lojista: ${telefoneDono}`);

    // 1. Busca os últimos 5 Erros Críticos deste usuário (ou globais)
    const { data: erros } = await supabaseAdmin
        .from('logs_erro')
        .select('*')
        .or(`whatsapp.eq.${telefoneDono},whatsapp.is.null`)
        .order('created_at', { ascending: false })
        .limit(10);

    // 2. Busca as últimas 200 entradas de auditoria de fluxo do Owner
    const { data: fluxo } = await supabaseAdmin
        .from('logs_dev')
        .select('created_at, nivel, contexto, mensagem, dados')
        .eq('whatsapp', telefoneDono)
        .order('created_at', { ascending: false })
        .limit(200);

    // 3. Busca as últimas 20 mensagens no histórico deste usuário
    const { data: historico } = await supabaseAdmin
        .from('historico_mensagens')
        .select('created_at, role, content')
        .eq('whatsapp', telefoneDono)
        .order('created_at', { ascending: false })
        .limit(20);

    console.log('\n======================================================');
    console.log('🔬 TRILHA DE AUDITORIA DE FLUXO (logs_dev) — 200 eventos');
    console.log('======================================================');
    if (!fluxo || fluxo.length === 0) {
        console.log('Nenhum log de auditoria encontrado. Envie uma mensagem com seu número de dono para começar.');
    } else {
        fluxo.reverse().forEach((e: any) => {
            const icone = e.nivel === 'error' ? '🔴' : e.nivel === 'warn' ? '🟡' : '🟢';
            console.log(`${icone} [${e.created_at}] [${e.contexto}] ${e.mensagem}`);
            if (e.dados) console.log(`   Dados: ${JSON.stringify(e.dados).substring(0, 120)}`);
        });
    }

    console.log('\n======================================================');
    console.log('🚨 ÚLTIMOS ERROS CRÍTICOS (Render / Sistema)');
    console.log('======================================================');
    if (!erros || erros.length === 0) {
        console.log('✅ Nenhum erro fatal registrado recentemente.');
    } else {
        erros.reverse().forEach((e: any) => {
            console.log(`[${e.created_at}] [${e.origem}] ${e.mensagem}`);
            if (e.contexto) console.log(`   Contexto: ${JSON.stringify(e.contexto)}`);
        });
    }

    console.log('\n======================================================');
    console.log('💬 ÚLTIMAS MENSAGENS (Timeline do Flow — 20 msgs)');
    console.log('======================================================');
    if (!historico || historico.length === 0) {
        console.log('Nenhum histórico encontrado.');
    } else {
        historico.reverse().forEach((msg: any) => {
            const r = msg.role === 'user' ? 'Lojista' : 'Robô';
            const exc = msg.content.substring(0, 80).replace(/\n/g, ' ');
            console.log(`[${msg.created_at}] [${r}] ${exc}${msg.content.length > 80 ? '...' : ''}`);
        });
    }
    console.log('\n✅ Diagnóstico concluído. Analise a linha do tempo acima.\n');
}

import { env } from '../src/config.js';

// Argumento CLI
const phone = process.argv[2] || env.ACHAZAP_OWNER_NUMBER;
if (!phone) {
    console.error('❌ Por favor, passe um número de telefone como argumento: npx tsx scripts/diagnostics.ts 5591...');
    process.exit(1);
}

rodarDiagnostico(phone);
