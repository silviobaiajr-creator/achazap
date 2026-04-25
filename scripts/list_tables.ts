import 'dotenv/config';
import { pool } from '../src/lib/db.js';

async function list() {
  try {
    const res = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
    console.log('Tabelas encontradas:', res.rows.map(r => r.table_name).join(', '));
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

list();
