import axios from 'axios';

const BASE_URL = 'https://graph.facebook.com/v19.0';
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID!;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN!;

import { env } from '../config.js';
import { cache } from './redis-cloud.js';
import { enviarLogAuditoria } from './audit.js';

/**
 * Envia uma mensagem de texto simples para um número WhatsApp.
 */
export async function sendTextMessage(to: string, text: string): Promise<void> {
    if (ACCESS_TOKEN.startsWith('EAAxxxxx') || !ACCESS_TOKEN) {
        console.log(`\n📱 [SIMULADOR WHATSAPP] Mensagem enviada para ${to}:`);
        console.log(`\x1b[36m${text}\x1b[0m\n`);
        return;
    }

    enviarLogAuditoria({
        whatsapp: to,
        nivel: 'info',
        contexto: 'BOT_OUTPUT',
        mensagem: `🤖 [Texto] "${text.substring(0, 100).replace(/\n/g, ' ')}..."`,
        dados: { type: 'text', text }
    });

    const MAX_TENTATIVAS = 3;
    for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
        try {
            await axios.post(
                `${BASE_URL}/${PHONE_NUMBER_ID}/messages`,
                {
                    messaging_product: 'whatsapp',
                    recipient_type: 'individual',
                    to,
                    type: 'text',
                    text: { body: text },
                },
                {
                    headers: {
                        Authorization: `Bearer ${ACCESS_TOKEN}`,
                        'Content-Type': 'application/json',
                    },
                }
            );
            return; // sucesso — sai do loop
        } catch (error: any) {
            const status = error?.response?.status;

            // Sprint 1 #12: usuário bloqueou o bot — não tentar novamente
            if (status === 403) {
                console.error(`❌ [WhatsApp 403] Usuário ${to} bloqueou o bot. Registrar inatividade.`);
                try {
                    const { createClient: getSupabase } = await import('@supabase/supabase-js');
                    const sb = getSupabase(process.env.SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!);
                    await sb.from('lojas').update({ ativa: false }).eq('whatsapp', to);
                } catch { /* ignora falha ao registrar */ }
                return; // encerra sem re-lançar
            }

            // Sprint 1 #13: rate limit — espera exponencial e tenta novamente
            if (status === 429) {
                const wait = Math.pow(2, tentativa) * 1000; // 2s, 4s, 8s
                console.warn(`⚠️ [WhatsApp 429] Rate limit para ${to}. Aguardando ${wait}ms (tentativa ${tentativa}/${MAX_TENTATIVAS})`);
                await new Promise(r => setTimeout(r, wait));
                continue;
            }

            // Outros erros: loga e re-lança
            console.error('❌ Erro na API do WhatsApp:', error?.response?.data || error.message);
            if (tentativa === MAX_TENTATIVAS) throw error;
        }
    }
}

/**
 * Envia um alerta crítico para o WhatsApp do dono do sistema.
 * Implementa trava de spam de 5 minutos por tipo de erro.
 */
export async function enviarAlertaDono(conteudo: string, contexto?: string): Promise<void> {
    const owner = env.ACHAZAP_OWNER_NUMBER;
    if (!owner) return;

    // Trava de spam: 5 minutos por "assinatura" do erro (conteúdo simplificado)
    const erroHash = `msg_alerta_dono:${conteudo.substring(0, 50)}`;
    if (cache.get(erroHash)) {
        console.info(`[AlertaDono] Alerta duplicado silenciado: ${conteudo.substring(0, 30)}...`);
        return;
    }
    cache.set(erroHash, true, 5 * 60 * 1000);

    const prefixo = '🚨 *[AchaZap - Alerta Sistema]*\n\n';
    const msgFinal = `${prefixo}${conteudo}${contexto ? `\n\n📌 *Contexto:* ${contexto}` : ''}`;
    
    await sendTextMessage(owner, msgFinal).catch(err => {
        console.error('❌ Falha crítica ao enviar alerta para o dono:', err.message);
    });
}


/**
 * Envia botões interativos (limite de 3).
 */
export async function sendInteractiveButtons(to: string, bodyText: string, buttons: { id: string, title: string }[]): Promise<void> {
    if (ACCESS_TOKEN.startsWith('EAAxxxxx') || !ACCESS_TOKEN) {
        console.log(`\n📱 [SIMULADOR BOTÕES] Enviado para ${to}: ${bodyText}`);
        buttons.forEach(b => console.log(`   [Botão: ${b.title} (ID: ${b.id})]`));
        return;
    }

    enviarLogAuditoria({
        whatsapp: to,
        nivel: 'info',
        contexto: 'BOT_OUTPUT',
        mensagem: `🤖 [Botões] "${bodyText.substring(0, 80).replace(/\n/g, ' ')}..." | Opções: ${buttons.map(b => b.title).join(', ')}`,
        dados: { type: 'interactive_buttons', bodyText, buttons }
    });

    try {
        await axios.post(
            `${BASE_URL}/${PHONE_NUMBER_ID}/messages`,
            {
                messaging_product: 'whatsapp',
                to,
                type: 'interactive',
                interactive: {
                    type: 'button',
                    body: { text: bodyText },
                    action: {
                        buttons: buttons.map(b => ({
                            type: 'reply',
                            reply: { id: b.id, title: b.title.substring(0, 20) }
                        }))
                    }
                }
            },
            {
                headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
            }
        );
    } catch (error: any) {
        console.error('❌ Erro enviando botões:', error?.response?.data || error.message);
    }
}

/**
 * Envia uma lista interativa (limite de 10 itens).
 */
export async function sendListMessage(to: string, bodyText: string, buttonLabel: string, sections: { title: string, rows: { id: string, title: string, description?: string }[] }[]): Promise<void> {
    if (ACCESS_TOKEN.startsWith('EAAxxxxx') || !ACCESS_TOKEN) {
        console.log(`\n📱 [SIMULADOR LISTA] Enviado para ${to}: ${bodyText}`);
        return;
    }

    enviarLogAuditoria({
        whatsapp: to,
        nivel: 'info',
        contexto: 'BOT_OUTPUT',
        mensagem: `🤖 [Lista] "${bodyText.substring(0, 80).replace(/\n/g, ' ')}..."`,
        dados: { type: 'interactive_list', bodyText }
    });

    try {
        await axios.post(
            `${BASE_URL}/${PHONE_NUMBER_ID}/messages`,
            {
                messaging_product: 'whatsapp',
                to,
                type: 'interactive',
                interactive: {
                    type: 'list',
                    body: { text: bodyText },
                    action: {
                        button: buttonLabel.substring(0, 20),
                        sections
                    }
                }
            },
            {
                headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
            }
        );
    } catch (error: any) {
        console.error('❌ Erro enviando lista:', error?.response?.data || error.message);
    }
}

/**
 * Envia um botão interativo de Link Direto (Call to Action URL).
 * Permite 1-click para a loja.
 */
export async function sendCTAUrlMessage(to: string, bodyText: string, buttonText: string, url: string): Promise<void> {
    if (ACCESS_TOKEN.startsWith('EAAxxxxx') || !ACCESS_TOKEN) {
        console.log(`\n📱 [SIMULADOR CTA] Enviado para ${to}: ${bodyText}`);
        console.log(`   [Botão URL: ${buttonText} -> ${url}]`);
        return;
    }

    try {
        await axios.post(
            `${BASE_URL}/${PHONE_NUMBER_ID}/messages`,
            {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to,
                type: 'interactive',
                interactive: {
                    type: 'cta_url',
                    body: { text: bodyText },
                    action: {
                        name: 'cta_url',
                        parameters: {
                            display_text: buttonText.substring(0, 20),
                            url: url
                        }
                    }
                }
            },
            {
                headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
            }
        );
    } catch (error: any) {
        console.error('❌ Erro enviando CTA URL:', error?.response?.data || error.message);
    }
}


/**
 * Retorna a URL segura de download da mídia a partir do media_id.
 */
export async function getMediaUrl(mediaId: string): Promise<string> {
    if (ACCESS_TOKEN.startsWith('EAAxxxxx')) {
        return 'https://example.com/mock-media-url';
    }
    const { data } = await axios.get(`${BASE_URL}/${mediaId}`, {
        headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    return data.url as string;
}

/**
 * Faz download binário da mídia (CSV, Foto, Áudio) já autenticado.
 */
export async function downloadMedia(mediaId: string): Promise<Buffer> {
    const url = await getMediaUrl(mediaId);
    
    if (ACCESS_TOKEN.startsWith('EAAxxxxx')) {
        // Mock avançado: lê a tabela bagunçada do disco para testar a inteligência do Gemini
        const fs = await import('fs');
        const path = await import('path');
        const filePath = path.resolve(process.cwd(), 'scripts', 'tabela_baguncada.csv');
        return fs.readFileSync(filePath);
    }

    const { data } = await axios.get(url, {
        headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
        responseType: 'arraybuffer',
    });
    return Buffer.from(data);
}

/**
 * Tipos de mensagem que o webhook pode receber (cobertura completa da Meta API).
 */
export type WhatsAppMessage = {
    from: string;
    type: 'text' | 'image' | 'audio' | 'video' | 'document' |
          'interactive' | 'sticker' | 'location' | 'contacts' | 'reaction' | 'voice';
    text?:        { body: string };
    image?:       { id: string; mime_type: string; file_size?: number; caption?: string };
    audio?:       { id: string; mime_type: string; file_size?: number };
    voice?:       { id: string; mime_type: string; file_size?: number };
    video?:       { id: string; mime_type: string; file_size?: number };
    document?:    { id: string; filename: string; mime_type: string };
    sticker?:     { id: string; mime_type: string };
    location?:    { latitude: number; longitude: number; name?: string; address?: string };
    contacts?:    Array<{ name: { formatted_name: string } }>;
    reaction?:    { message_id: string; emoji: string };
    interactive?: {
        type: 'button_reply' | 'list_reply';
        button_reply?: { id: string; title: string };
        list_reply?:   { id: string; title: string; description?: string };
    };
    timestamp: string;
};

// Tipos de mensagens que o bot aceita processar. Qualquer coisa fora disso é descartada.
const TIPOS_ACEITOS = new Set<string>([
    'text', 'image', 'audio', 'video', 'document', 'interactive', 'sticker',
    'location', 'contacts', 'reaction', 'voice'
]);

/**
 * Extrai a mensagem relevante do payload bruto do webhook da Meta.
 * Implementa allow-list de tipos e filtra echos/eventos de sistema.
 */
export function extractMessage(body: unknown): WhatsAppMessage | null {
    try {
        const raw = body as Record<string, unknown>;
        const entry = (raw.entry as unknown[])?.[0] as Record<string, unknown>;
        const changes = (entry?.changes as unknown[])?.[0] as Record<string, unknown>;
        const value = changes?.value as Record<string, unknown>;

        // ── Filtro 1: Descartar eventos que NÃO têm mensagens (status, read receipts, etc)
        const messages = value?.messages as unknown[];
        if (!messages || messages.length === 0) return null;

        const msg = messages[0] as Record<string, unknown>;

        // ── Filtro 2: Descartar tipos fora da allow-list (system, order, etc)
        const tipo = msg.type as string;
        if (!TIPOS_ACEITOS.has(tipo)) {
            console.info(`[Webhook] Mensagem ignorada (Tipo: ${tipo}, Motivo: allow-list)`);
            return null;
        }

        // ── Filtro 3: Descartar echos (mensagem enviada pelo próprio bot)
        // A Meta marca echos com context.from === phone_number_id
        const context = msg.context as Record<string, unknown> | undefined;
        if (context?.from === process.env.WHATSAPP_PHONE_NUMBER_ID || tipo === 'system') {
            console.info(`[Webhook] Echo/Sistema ignorado de ${msg.from}`);
            return null;
        }

        // ── Filtro 4: Rejeitar mensagens sem remetente válido
        if (!msg.from || typeof msg.from !== 'string') return null;

        return {
            from: msg.from as string,
            type: msg.type as WhatsAppMessage['type'],
            text: msg.text as WhatsAppMessage['text'],
            image: msg.image as WhatsAppMessage['image'],
            audio: msg.audio as WhatsAppMessage['audio'],
            voice: msg.voice as WhatsAppMessage['voice'],
            document: msg.document as WhatsAppMessage['document'],
            sticker: msg.sticker as WhatsAppMessage['sticker'],
            interactive: msg.interactive as WhatsAppMessage['interactive'],
            timestamp: msg.timestamp as string,
        };
    } catch {
        return null;
    }
}
