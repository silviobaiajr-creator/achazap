import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

async function runTest() {
  console.log('--- TESTE DE ELITE ---');
  
  // 1. Chamar o RPC com feijão (com acento) em Portel/Castanheira
  const { data: feijaoComAcento, error: e1 } = await s.rpc('buscar_ofertas', {
      p_cidade: 'Portel', p_bairro: 'Castanheira', p_estado: 'PA', p_query: 'feijão'
  });
  
  console.log('\nQuery: feijão (com acento)');
  if (e1) console.error('ERRO:', e1.message);
  else {
      console.log('Contagem:', feijaoComAcento?.length || 0);
      feijaoComAcento?.forEach(item => {
          console.log(`- ${item.produto_nome} | R$ ${item.preco_atual} | ${item.loja_nome}`);
      });
  }

  // 2. Chamar o RPC com feijao (sem acento)
  const { data: feijaoSemAcento, error: e2 } = await s.rpc('buscar_ofertas', {
      p_cidade: 'Portel', p_bairro: 'Castanheira', p_estado: 'PA', p_query: 'feijao'
  });
  
  console.log('\nQuery: feijao (sem acento)');
  if (e2) console.error('ERRO:', e2.message);
  else {
      console.log('Contagem:', feijaoSemAcento?.length || 0);
  }
}

runTest();
