import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!
);

async function run() {
  console.log('--- RELATORIO DE FEIJAO ---');
  const { data: items, error } = await supabase.from('catalogo_historico')
    .select('id, produto_nome, preco, disponivel, registrado_em, lojas!inner(id, nome, bairro, cidade, ativa, saldo_cliques)')
    .ilike('produto_nome', '%feij%');
  
  if (error) {
    console.error('ERRO:', error);
    return;
  }

  items.forEach(i => {
    console.log(`- ID: ${i.id.substring(0,8)} | [${i.produto_nome}] | R$ ${i.preco} | Disp: ${i.disponivel} | Loja: ${i.lojas.nome} | Bairro: ${i.lojas.bairro} | Cidade: ${i.lojas.cidade} | Saldo: ${i.lojas.saldo_cliques}`);
  });

  console.log('\n--- PERFIL SILVIO ---');
  const { data: user } = await supabase.from('usuarios').select('*').eq('whatsapp', '559184270560').single();
  console.log(user);
}
run();
