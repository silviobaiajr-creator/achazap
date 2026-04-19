import 'dotenv/config';
import { logErroCritico } from '../src/lib/monitor.js';

async function rodarTeste() {
    console.log('🧪 Iniciando o teste de disparo de Alerta para o Dono...');
    
    try {
        // Simulando um erro genérico que aconteceria na produção
        throw new Error('Falha simulada na IA para teste de resiliência.');
    } catch (err) {
        await logErroCritico({
            origem: 'FLUXO_TESTE',
            mensagem: '🚨 [TESTE] Simulação de Crash Crítico Ativada!',
            err,
            contexto: { 
                mensagem_do_user: 'O usuário tentou enviar um formato alienígena',
                temperatura: 'quente'
            }
        });
    }

    console.log('✅ O erro foi disparado para o Monitor e enviado ao seu WhatsApp!');
    console.log('👉 Em seguida, execute: npx tsx scripts/diagnostics.ts');
    process.exit(0);
}

rodarTeste();
