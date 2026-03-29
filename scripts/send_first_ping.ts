import 'dotenv/config';
import { sendTextMessage } from '../src/lib/whatsapp.js';

async function main() {
    const telefoneDestino = '559184270560'; // Seu celular pessoal que capturamos antes
    console.log(`[Teste] Enviando primeira mensagem da API para ${telefoneDestino}...`);

    try {
        await sendTextMessage(telefoneDestino, 'Olá, Silvio! Sou eu, o AchaZap. Deu tudo certo com o meu novo chip! 🤖🎉');
        console.log(`[Teste] Sucesso! Verifique o seu celular, a mensagem deve ter chegado!`);
    } catch (error: any) {
        console.error(`[Erro] A Meta recusou o envio:`, error.response?.data || error.message);
    }
}

main();
