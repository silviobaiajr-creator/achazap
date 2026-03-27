/**
 * Script de teste simples para verificar se a chave Gemini funciona
 * Rode com: npx tsx scripts/test_gemini.ts
 */
import { GoogleGenAI } from '@google/genai';
import 'dotenv/config';

async function testGemini() {
    console.log('🔑 Testando chave:', process.env.GEMINI_API_KEY?.substring(0, 15) + '...');

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: 'Diga apenas: "AchaZap funcionando!"',
        });
        console.log('✅ SUCESSO! Resposta do Gemini:', response.text);
    } catch (error: any) {
        console.error('❌ FALHOU!');
        console.error('Código do erro:', error?.status ?? error?.code);
        console.error('Mensagem:', error?.message?.substring(0, 300));
    }
}

testGemini();
