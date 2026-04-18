import 'dotenv/config';
import { limparContexto } from '../src/lib/redis-cloud.js';

async function clearUser() {
  const phone = '559184270560'; // Do log do usuário
  console.log(`Limpando sessão do usuário ${phone}...`);
  try {
    await limparContexto(phone);
    await limparContexto(`+${phone}`);
    console.log('Sessão limpa com sucesso! ✅');
  } catch (err) {
    console.error('Erro ao limpar sessão:', err);
  } finally {
      process.exit(0);
  }
}

clearUser();
