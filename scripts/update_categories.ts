import 'dotenv/config';
import { pool } from '../src/lib/db.js';

async function updateCategories() {
  try {
    console.log('Atualizando restrição de categorias na tabela lojas...');
    
    // Vamos tentar remover a restrição antiga e adicionar a nova com as opções expandidas
    // No Postgres, se não damos nome, ele geralmente cria como {tabela}_{coluna}_check
    await pool.query(`
      ALTER TABLE lojas DROP CONSTRAINT IF EXISTS lojas_categoria_check;
      
      ALTER TABLE lojas ADD CONSTRAINT lojas_categoria_check 
      CHECK (categoria IN (
        'supermercado', 'farmacia', 'construcao', 'padaria', 'acougue', 
        'pet', 'vestuario', 'calcados', 'restaurante', 'lanchonete', 
        'pizzaria', 'otica', 'eletronicos', 'cosmeticos', 'utilidades', 'outro'
      ));
    `);

    console.log('Restrição de categorias atualizada com sucesso! ✅');
  } catch (err) {
    console.error('Erro ao atualizar categorias:', err);
  } finally {
    await pool.end();
  }
}

updateCategories();
