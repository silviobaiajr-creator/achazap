import 'dotenv/config';
import { pool } from '../src/lib/db.js';

async function clearDB() {
  try {
    console.log('🧹 Iniciando limpeza PROFUNDA do banco de dados PostgreSQL...');
    
    // Deleta os dados de todas as tabelas em cascata
    const tables = [
        'lojas', 
        'usuarios', 
        'pacotes_cliques', 
        'cliques_consumidos', 
        'catalogo_historico',
        'catalogo_ativo',
        'historico_mensagens',
        'logs_dev',
        'logs_erro',
        'acoes_pendentes',
        'ofertas_desconto',
        'loja_insights_enviados'
    ];

    await pool.query(`TRUNCATE TABLE ${tables.join(', ')} CASCADE;`);
    console.log('✅ Todas as tabelas principais foram limpas no PostgreSQL.');

    // Limpar pg-boss
    try {
      await pool.query('TRUNCATE TABLE pgboss.job CASCADE;');
      console.log('📦 Fila do pg-boss limpa.');
    } catch (bossErr) {
      // Silencioso se não existir
    }

    console.log('\n🚀 BANCO DE DADOS ZERADO! Você pode começar os testes do zero agora.');
    console.log('💡 Dica: Se o servidor estiver rodando localmente, reinicie-o para limpar as sessões em memória.');
  } catch (err) {
    console.error('❌ Erro crítico na limpeza:', err);
  } finally {
    await pool.end();
    process.exit(0);
  }
}

clearDB();
