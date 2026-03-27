import { supabase } from '../src/lib/supabase.js';

async function checkClicks() {
    console.log('🔍 Verificando estado do clique: 9d9aebfa11a646ca824b1929cd8000e2');
    
    // Ler o clique
    const { data: clique } = await supabase
        .from('cliques_consumidos')
        .select('*')
        .eq('link_token', '9d9aebfa11a646ca824b1929cd8000e2')
        .single();
        
    console.log('\n📊 Registro na tabela cliques_consumidos:');
    console.log(clique);

    if (clique) {
        // Ler saldo da loja
        const { data: loja } = await supabase
            .from('lojas')
            .select('nome, saldo_cliques')
            .eq('id', clique.loja_id)
            .single();

        console.log('\n🏪 Saldo atual da loja:');
        console.log(loja);
    }
}

checkClicks();
