import 'dotenv/config';
import { supabase } from './src/lib/supabase.js';

async function verify() {
  console.log('--- TESTE DE BUSCA REAL (Portel, Castanheira, PA) ---');
  
  try {
      // Teste 1: feijao (sem acento)
      console.log('\nQuery: feijao');
      const { data: d1, error: e1 } = await supabase.rpc('buscar_ofertas', {
        p_cidade: 'Portel', p_bairro: 'Castanheira', p_estado: 'PA', p_query: 'feijao'
      });
      if (e1) {
          console.error('Erro 1:', e1.message);
      } else {
          console.log('Resultados (feijao):', d1.map((i: any) => ({ nome: i.produto_nome, preco: i.preco_atual })));
      }

      // Teste 2: feijão (com acento)
      console.log('\nQuery: feijão');
      const { data: d2, error: e2 } = await supabase.rpc('buscar_ofertas', {
        p_cidade: 'Portel', p_bairro: 'Castanheira', p_estado: 'PA', p_query: 'feijão'
      });
      if (e2) {
          console.error('Erro 2:', e2.message);
      } else {
          console.log('Resultados (feijão):', d2.map((i: any) => ({ nome: i.produto_nome, preco: i.preco_atual })));
      }
  } catch (err: any) {
      console.error('CRITICAL ERROR:', err.message);
  }
}

verify();
