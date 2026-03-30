import 'dotenv/config';
import { supabase } from './src/lib/supabase.js';

async function test() {
  console.log('--- USUARIOS ---');
  const { data: u } = await supabase.from('usuarios').select('*').limit(5);
  console.log(u);

  console.log('\n--- LOJAS ---');
  const { data: l } = await supabase.from('lojas').select('*').limit(5);
  console.log(l);

  console.log('\n--- CATALOGO (FEIJAO) ---');
  const { data: c } = await supabase.from('catalogo_historico').select('*').ilike('produto_nome', '%feij%').limit(10);
  console.log(c);
  
  console.log('\n--- TESTE UNACCENT ---');
  const { data: ua, error: uae } = await supabase.rpc('buscar_ofertas', {
      p_cidade: 'Portel',
      p_bairro: 'Castanheira',
      p_estado: 'PA',
      p_query: 'feijao'
  });
  console.log('Busca por feijao:', ua || uae);
}

test();
