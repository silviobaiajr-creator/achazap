import 'dotenv/config';
import { pool } from '../src/lib/db.js';

async function check() {
  try {
    const res = await pool.query("SELECT * FROM logs_dev ORDER BY created_at DESC LIMIT 50");
    console.log(JSON.stringify(res.rows, null, 2));
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

check();
