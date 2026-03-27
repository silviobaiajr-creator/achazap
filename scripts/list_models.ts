import 'dotenv/config';

async function listModels() {
    console.log('🔍 Buscando modelos disponíveis para sua chave...');
    const apiKey = process.env.GEMINI_API_KEY;
    
    if (!apiKey) {
        console.error('❌ Chave GEMINI_API_KEY não encontrada no .env');
        return;
    }

    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
        const data = await response.json();
        
        if (data.error) {
            console.error('❌ Erro da API:', data.error.message);
            return;
        }

        console.log('\\n✅ Modelos disponíveis que suportam generateContent:');
        const models = data.models || [];
        
        for (const model of models) {
            if (model.supportedGenerationMethods && model.supportedGenerationMethods.includes('generateContent')) {
                console.log(`- ${model.name.replace('models/', '')} (${model.displayName})`);
            }
        }
    } catch (error) {
        console.error('❌ Erro na requisição:', error);
    }
}

listModels();
