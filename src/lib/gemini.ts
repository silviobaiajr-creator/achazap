import { GoogleGenAI } from '@google/genai';

export const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
export const GEMINI_MODEL = 'gemini-1.5-flash';
