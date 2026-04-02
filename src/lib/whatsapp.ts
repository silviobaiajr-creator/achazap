import axios from 'axios';

const BASE_URL = 'https://graph.facebook.com/v19.0';
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID!;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN!;

/**
 * Envia uma mensagem de texto simples para um número WhatsApp.
 */
export async function sendTextMessage(to: string, text: string): Promise<void> {
    if (ACCESS_TOKEN.startsWith('EAAxxxxx') || !ACCESS_TOKEN) {
        console.log(`\\n📱 [SIMULADOR WHATSAPP] Mensagem enviada para ${to}:`);
        console.log(`\\x1b[36m${text}\\x1b[0m\\n`);
        return;
    }

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
    } catch (error: any) {
        console.error('❌ Erro real na API do WhatsApp:', error?.response?.data || error.message);
        throw error;
    }
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
 * Tipos de mensagem que o webhook pode receber.
 */
export type WhatsAppMessage = {
    from: string;        // número do remetente (ex: "5511999999999")
    type: 'text' | 'image' | 'audio' | 'document' | 'interactive' | 'sticker';
    text?: { body: string };
    image?: { id: string; mime_type: string; caption?: string };
    audio?: { id: string; mime_type: string };
    document?: { id: string; filename: string; mime_type: string };
    sticker?: { id: string; mime_type: string };
    interactive?: {
        type: 'button_reply' | 'list_reply';
        button_reply?: { id: string; title: string };
        list_reply?: { id: string; title: string; description?: string };
    };
    timestamp: string;
};

/**
 * Extrai a mensagem relevante do payload bruto do webhook da Meta.
 */
export function extractMessage(body: unknown): WhatsAppMessage | null {
    try {
        const raw = body as Record<string, unknown>;
        const entry = (raw.entry as unknown[])?.[0] as Record<string, unknown>;
        const changes = (entry?.changes as unknown[])?.[0] as Record<string, unknown>;
        const value = changes?.value as Record<string, unknown>;
        const messages = value?.messages as unknown[];
        if (!messages || messages.length === 0) return null;

        const msg = messages[0] as Record<string, unknown>;
        return {
            from: msg.from as string,
            type: msg.type as WhatsAppMessage['type'],
            text: msg.text as WhatsAppMessage['text'],
            image: msg.image as WhatsAppMessage['image'],
            audio: msg.audio as WhatsAppMessage['audio'],
            document: msg.document as WhatsAppMessage['document'],
            sticker: msg.sticker as WhatsAppMessage['sticker'],
            interactive: msg.interactive as WhatsAppMessage['interactive'],
            timestamp: msg.timestamp as string,
        };
    } catch {
        return null;
    }
}
