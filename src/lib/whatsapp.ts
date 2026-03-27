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
 * Faz download de mídia (imagem/áudio) a partir do media_id retornado pelo webhook.
 */
export async function getMediaUrl(mediaId: string): Promise<string> {
    const { data } = await axios.get(`${BASE_URL}/${mediaId}`, {
        headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    return data.url as string;
}

/**
 * Tipos de mensagem que o webhook pode receber.
 */
export type WhatsAppMessage = {
    from: string;        // número do remetente (ex: "5511999999999")
    type: 'text' | 'image' | 'audio' | 'document' | 'interactive';
    text?: { body: string };
    image?: { id: string; mime_type: string; caption?: string };
    audio?: { id: string; mime_type: string };
    document?: { id: string; filename: string; mime_type: string };
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
            timestamp: msg.timestamp as string,
        };
    } catch {
        return null;
    }
}
