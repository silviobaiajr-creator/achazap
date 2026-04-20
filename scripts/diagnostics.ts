import 'dotenv/config';
import { supabaseAdmin } from '../src/lib/supabase.js';
import { env } from '../src/config.js';

/**
 * Script de Diagnóstico para uso exclusivo do AchaZap AI (Antigravity).
 * Entra no banco e traz erros + trilha de auditoria de qualquer usuário.
 * Uso:
 *   npx tsx scripts/diagnostics.ts               → últimos 50 eventos de qualquer usuário (visão global)
 *   npx tsx scripts/diagnostics.ts 5591XXXXXXX   → eventos filtrados para esse número
 */

async function rodarDiagnosticoGlobal() {
    console.log(`\n📡 VISÃO GLOBAL — Últimos 50 eventos de qualquer usuário`);

    const { data: fluxo } = await supabaseAdmin
        .from('logs_dev')
        .select('created_at, whatsapp, nivel, contexto, mensagem, dados')
        .order('created_at', { ascending: false })
        .limit(50);

    console.log('\n======================================================');
    console.log('🔬 TRILHA GLOBAL DE AUDITORIA (logs_dev)');
    console.log('======================================================');
    if (!fluxo || fluxo.length === 0) {
        console.log('Nenhum log encontrado.');
    } else {
        fluxo.reverse().forEach((e: any) => {
            const icone = e.nivel === 'error' ? '🔴' : e.nivel === 'warn' ? '🟡' : '🟢';
            const shortWa = String(e.whatsapp || '').slice(-4);
            console.log(`${icone} [${e.created_at}] [****${shortWa}] [${e.contexto}] ${e.mensagem}`);
            if (e.dados) console.log(`   Dados: ${JSON.stringify(e.dados).substring(0, 120)}`);
        });
    }

    const { data: erros } = await supabaseAdmin
        .from('logs_erro')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(5);

    console.log('\n======================================================');
    console.log('🚨 ÚLTIMOS ERROS CRÍTICOS');
    console.log('======================================================');
    if (!erros || erros.length === 0) {
        console.log('✅ Nenhum erro fatal registrado recentemente.');
    } else {
        erros.reverse().forEach((e: any) => {
            console.log(`[${e.created_at}] [${e.origem}] ${e.mensagem}`);
            if (e.contexto) console.log(`   Contexto: ${JSON.stringify(e.contexto)}`);
        });
    }

    console.log('\n✅ Diagnóstico global concluído.\n');
}

async function rodarDiagnostico(telefoneDono: string) {
    console.log(`\n🔍 Diagnóstico para: ${telefoneDono}`);

    // 1. Erros críticos deste usuário ou globais
    const { data: erros } = await supabaseAdmin
        .from('logs_erro')
        .select('*')
        .or(`whatsapp.eq.${telefoneDono},whatsapp.is.null`)
        .order('created_at', { ascending: false })
        .limit(10);

    // 2. Trilha de auditoria de fluxo deste número
    const { data: fluxo } = await supabaseAdmin
        .from('logs_dev')
        .select('created_at, nivel, contexto, mensagem, dados')
        .eq('whatsapp', telefoneDono)
        .order('created_at', { ascending: false })
        .limit(200);

    // 3. Histórico de mensagens (IA)
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
        console.log('Nenhum log de auditoria encontrado para este número.');
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
            const r = msg.role === 'user' ? 'Usuário' : 'Robô';
            const exc = msg.content.substring(0, 80).replace(/\n/g, ' ');
            console.log(`[${msg.created_at}] [${r}] ${exc}${msg.content.length > 80 ? '...' : ''}`);
        });
    }

    console.log('\n✅ Diagnóstico concluído. Analise a linha do tempo acima.\n');
}

// Argumento CLI
const phone = process.argv[2];
if (!phone) {
    // Sem argumento → visão global de todos os usuários
    rodarDiagnosticoGlobal();
} else {
    rodarDiagnostico(phone);
}
