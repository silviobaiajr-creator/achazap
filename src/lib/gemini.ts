import { GoogleGenAI } from '@google/genai';
import { verificarQuotaBloqueadaDB, incrementarQuotaDB, QUOTA_GLOBAL_DIARIA } from './token-quota.js';
import { logger } from './logger.js';

const _ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
export const GEMINI_MODEL = 'gemini-2.5-flash-lite';

/**
 * Proxy Global do Gemini.
 * Garante que TODA E QUALQUER requisição feita pela aplicação (seja no Webhook, 
 * Vision, Roteador NLP, Worker, etc) passe obrigatoriamente pela barreira
 * de quota diária persistente, blindando contra cobranças abusivas.
 */
export const ai = {
    models: {
        generateContent: async (params: any) => {
            // 🛡️ GUARDIÃO FINANCEIRO: Interceptação pré-requisição
            const bloqueado = await verificarQuotaBloqueadaDB('global', QUOTA_GLOBAL_DIARIA);
            if (bloqueado) {
                logger.error('🛡️ [DEFESA FINANCEIRA] Bloqueio Global Acionado. Cota de tokens atingiu o teto diário.');
                throw new Error('QUOTA_EXCEDIDA: Limite diário de tokens excedido. Operação abortada para proteção financeira.');
            }

            // 🚀 Requisição real ao Google
            const res = await _ai.models.generateContent(params);
            
            // 📊 Contabilização post-mortem
            const usage = res.usageMetadata;
            if (usage && usage.totalTokenCount) {
                incrementarQuotaDB('global', usage.totalTokenCount, QUOTA_GLOBAL_DIARIA).catch((err: any) => {
                    logger.error({ err }, '[GeminiProxy] Falha não-bloqueante ao registrar tokens no banco de dados');
                });
            }
            return res;
        },
        embedContent: async (params: any) => {
            const bloqueado = await verificarQuotaBloqueadaDB('global', QUOTA_GLOBAL_DIARIA);
            if (bloqueado) {
                logger.error('🛡️ [DEFESA FINANCEIRA] Bloqueio Global Acionado no embedContent.');
                throw new Error('QUOTA_EXCEDIDA: Limite diário de tokens excedido. Operação abortada para proteção financeira.');
            }

            const res = await _ai.models.embedContent(params);
            
            // Assumimos média de tokens do vetor dependendo do chunk (SDK expõe values.length)
            const valores = (res as any)?.embeddings?.[0]?.values;
            const tokensUsados = valores ? valores.length : 1500;
            
            incrementarQuotaDB('global', tokensUsados, QUOTA_GLOBAL_DIARIA).catch((err: any) => {
                logger.error({ err }, '[GeminiProxy] Falha não-bloqueante ao registrar tokens no banco de dados');
            });
            return res;
        }
    }
};
