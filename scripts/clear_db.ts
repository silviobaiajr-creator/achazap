import 'dotenv/config';
import { pool } from '../src/lib/db.js';

async function clearDB() {
  try {
    console.log('Iniciando limpeza do banco de dados (TRUNCATE)...');
    
    // Deleta os dados de todas as tabelas em cascata
    await pool.query(`
      TRUNCATE TABLE 
        lojas, 
        usuarios, 
        pacotes_cliques, 
        cliques_consumidos, 
        catalogo_historico 
      CASCADE;
    `);

    console.log('Tabelas principais limpas com sucesso.');

    // Opcional: Limpar a fila do pg-boss se existir
    try {
      await pool.query('TRUNCATE TABLE pgboss.job CASCADE;');
      console.log('Tabela de jobs do pg-boss limpa com sucesso.');
    } catch (bossErr) {
      console.log('Aviso: Tabela pgboss.job não encontrada ou erro ao limpá-la.', bossErr instanceof Error ? bossErr.message : bossErr);
    }

    console.log('Banco de dados zerado para testes! 🚀');
  } catch (err) {
    console.error('Erro ao limpar banco de dados:', err);
  } finally {
    await pool.end();
  }
}

clearDB();
