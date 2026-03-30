import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!
);

async function runTest() {
  console.log('--- TESTE DE ELITE: SILVIO + FEIJAO ---');
  
  // 1. Chamar o RPC para Silas (Portel, Castanheira, PA)
  const { data, error } = await supabase.rpc('buscar_ofertas', {
    p_cidade: 'Portel',
    p_bairro: 'Castanheira',
    p_estado: 'PA',
    p_query: 'feijão'
  });

  if (error) {
    console.error('ERRO:', error.message);
  } else {
    console.log('ENCONTRADOS:', data.length);
    data?.forEach((i: any) => {
      console.log(`- ${i.produto_nome} | R$ ${i.preco_atual} | Loja: ${i.loja_nome}`);
    });
  }

  // 2. Ver o RAW de todos os feijões em Portel
  const { data: raw } = await supabase.from('catalogo_historico')
    .select('*, lojas!inner(*)')
    .eq('lojas.cidade', 'Portel')
    .ilike('produto_nome', '%feij%');
  
  console.log('\n--- RAW DATA (PORTEL) ---');
  raw?.forEach(r => {
    console.log(`Bairro: ${r.lojas.bairro} | Nome: ${r.produto_nome} | Preco: ${r.preco} | Disp: ${r.disponivel} | Saldo: ${r.lojas.saldo_cliques}`);
  });
}

runTest();
