import { processMessage } from '../src/ai/orchestrator.js';
import { supabaseAdmin as supabase } from '../src/lib/supabase.js';

// Função auxiliar para mockar mensagens
function criarMensagemMock(from: string, type: 'text' | 'interactive', text: string = '', buttonId: string = '') {
    return {
        id: `msg_${Math.random()}`,
        from,
        type,
        timestamp: String(Date.now()),
        text: type === 'text' ? { body: text } : undefined,
        interactive: type === 'interactive' ? { 
            type: 'button_reply', 
            button_reply: { id: buttonId, title: text } 
        } : undefined
    };
}

async function runTest() {
    const telefoneTeste = '+5511999990000'; // Um número não cadastrado como loja

    console.log('\n=======================================');
    console.log('🧪 INICIANDO TESTE DO MODO CONSUMIDOR');
    console.log('=======================================\n');

    // 1. Limpando sujeira de testes anteriores
    await supabase.from('contextos_sessao').delete().eq('whatsapp', telefoneTeste);
    await supabase.from('usuarios').delete().eq('whatsapp', telefoneTeste);
    console.log('[Setup] Contexto limpo.');

    // 2. Primeiro Contato (Oi)
    console.log('\n--> Consumidor diz "Oi"');
    await processMessage(criarMensagemMock(telefoneTeste, 'text', 'Oi'));
    await new Promise(r => setTimeout(r, 2000));

    // 3. Escolhe Onboarding Consumidor
    console.log('\n--> Consumidor escolhe "Quero Comprar" (perf_consumidor)');
    await processMessage(criarMensagemMock(telefoneTeste, 'interactive', 'Quero Comprar', 'perf_consumidor'));
    await new Promise(r => setTimeout(r, 2000));

    // 4. Fornece Localização
    console.log('\n--> Consumidor envia Localização "São Paulo, Pinheiros"');
    await processMessage(criarMensagemMock(telefoneTeste, 'text', 'São Paulo, Pinheiros'));
    await new Promise(r => setTimeout(r, 2000));

    // 5. Busca um produto (Ex: dipirona)
    console.log('\n--> Consumidor busca "dipirona"');
    await processMessage(criarMensagemMock(telefoneTeste, 'text', 'dipirona'));
    await new Promise(r => setTimeout(r, 4000));

    // 6. Clica em Revelar
    // Como os IDs são dinâmicos (vêm do banco), seria ideal buscar na tabela qual ID gerar. 
    // Vamos simular mandando um revelar fantasma para ver se a rota no Orchestrator não dá crash.
    console.log('\n--> Consumidor clica em "Revelar" (Cenário Hipotético)');
    await processMessage(criarMensagemMock(telefoneTeste, 'interactive', 'Revelar Opção 1', 'revelar_123_456'));
    
    console.log('\n✅ Teste Concluído. Analise os logs impressos acima.');
}

runTest().catch(console.error).finally(() => process.exit(0));
