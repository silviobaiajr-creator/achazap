import axios from 'axios';

/**
 * Script de Teste Local: Simula um LOJISTA enviando um documento (CSV)
 */
async function testUpload() {
    const WEBHOOK_URL = 'http://localhost:3000/webhook';
    
    // O número 5519988880001 é o telefone do 'Supermercado Cambuí' no seed do banco!
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
                            contacts: [{ profile: { name: 'Super Cambuí' }, wa_id: '5519988880001' }],
                            messages: [
                                {
                                    from: '+5519988880001',
                                    id: `wamid.test_doc_${Date.now()}`,
                                    timestamp: Math.floor(Date.now() / 1000).toString(),
                                    type: 'document',
                                    document: {
                                        id: 'midia_teste_fake_123',
                                        filename: 'tabela_precos_desorganizada.csv',
                                        mime_type: 'text/csv'
                                    }
                                }
                            ]
                        },
                        field: 'messages'
                    }
                ]
            }
        ]
    };

    console.log('🚀 Enviando planilha CSV (simulada) para o Webhook...');
    
    try {
        const response = await axios.post(WEBHOOK_URL, payload);
        console.log('✅ Resposta do Webhook:', response.status, response.data);
        console.log('\n---');
        console.log('DICA: O "whatsapp.ts" está mockado para gerar um CSV automático com Feijão e Arroz. Veja o terminal principal!');
        console.log('---');
    } catch (error: any) {
        console.error('❌ Erro ao testar webhook:', error.response?.data || error.message);
    }
}

testUpload();
