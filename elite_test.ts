import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!
);

async function finalFix() {
  console.log('--- TESTE DE ELITE: FEIJAO ---');
  
  // 1. Ver se o RPC existe e funciona com extensions.unaccent
  const { data, error } = await supabase.rpc('buscar_ofertas', {
    p_cidade: 'Portel',
    p_bairro: 'Castanheira',
    p_estado: 'PA',
    p_query: 'feijao'
  });

  if (error) {
    console.error('ERRO RPC:', error.message);
  } else {
    console.log('ENCONTRADOS POR RPC:', data.length, 'itens');
    data.forEach((i: any) => {
      console.log(`- ${i.produto_nome} | Preço: ${i.preco_atual} | Loja: ${i.loja_id}`);
    });
  }

  // 2. Ver o RAW de todos os feijões em Portel (Independente de Bairro para comparar)
  const { data: raw } = await supabase.from('catalogo_historico')
    .select('*, lojas!inner(*)')
    .eq('lojas.cidade', 'Portel')
    .ilike('produto_nome', '%feij%');
  
  console.log('\n--- DATA RAW (PORTEL) ---');
  if (raw) {
      raw.forEach(r => {
        console.log(`ID: ${r.id} | Nome: ${r.produto_nome} | Preco: ${r.preco} | Disp: ${r.disponivel} | Bairro: ${r.lojas.bairro} | Cidade: ${r.lojas.cidade}`);
      });
  } else {
      console.log('Nenhum item de feijao encontrado no raw.');
  }
}

finalFix();
