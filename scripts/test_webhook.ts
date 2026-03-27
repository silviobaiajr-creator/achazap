import axios from 'axios';

/**
 * Script de Teste Local: Simula uma mensagem recebida do WhatsApp
 * Isso testa a rota POST /webhook, o enfileiramento no BullMQ 
 * e o processamento inicial pela IA.
 */
async function testWebhook() {
    const WEBHOOK_URL = 'http://localhost:3000/webhook';
    
    const payload = {
        object: 'whatsapp_business_account',
        entry: [
            {
                id: '123456789',
                changes: [
                    {
                        value: {
                            messaging_product: 'whatsapp',
                            metadata: {
                                display_phone_number: '5511999999999',
                                phone_number_id: '987654321'
                            },
                            contacts: [{ profile: { name: 'Silvio Teste' }, wa_id: '5519977770001' }],
                            messages: [
                                {
                                    from: '5519977770001',
                                    id: 'wamid.HBgLNTUxOTk3Nzc3MDAwMRUCABEYEjA0REI2QzU0REU0Q0RDMzRGMAA=',
                                    timestamp: Math.floor(Date.now() / 1000),
                                    text: { body: 'Meu nome é Silvio. E já te falei que sou de Campinas, do Cambuí. Cadê o arroz?' },
                                    type: 'text'
                                }
                            ]
                        },
                        field: 'messages'
                    }
                ]
            }
        ]
    };

    console.log('🚀 Enviando mensagem de teste para o Webhook...');
    
    try {
        const response = await axios.post(WEBHOOK_URL, payload);
        console.log('✅ Resposta do Webhook:', response.status, response.data);
        console.log('\n---');
        console.log('DICA: Verifique o terminal onde o servidor está rodando para ver o processador em ação.');
        console.log('---');
    } catch (error: any) {
        console.error('❌ Erro ao testar webhook:', error.response?.data || error.message);
        if (error.code === 'ECONNREFUSED') {
            console.error('ERRO: O servidor não parece estar rodando em http://localhost:3000');
        }
    }
}

testWebhook();
