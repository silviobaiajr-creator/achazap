import { Redis } from 'ioredis';

let redisCloudClient: Redis | null = null;

export function createRedisCloudClient(): Redis {
    const url = process.env.REDIS_CLOUD_URL;

    if (!url) {
        console.warn('[Redis Cloud] ⚠️ REDIS_CLOUD_URL não definida. Usando Redis local.');
        return new Redis({
            host: 'localhost',
            port: 6379,
            lazyConnect: true,
        });
    }

    const isTLS = url.startsWith('rediss://');

    return new Redis(url, {
        maxRetriesPerRequest: 3,
        retryStrategy: (times: number) => {
            if (times > 3) {
                console.error('[Redis Cloud] ❌ Máximo de tentativas excedido');
                return null;
            }
            return Math.min(times * 200, 2000);
        },
        enableReadyCheck: true,
        ...(isTLS ? { tls: {} } : {}),
    });
}

export function getRedisCloudClient(): Redis {
    if (!redisCloudClient) {
        redisCloudClient = createRedisCloudClient();
    }
    return redisCloudClient;
}

export async function obterRedis(): Promise<Redis> {
    return getRedisCloudClient();
}

// ============================================================
// Funções de Estado da Conversa (Máquina de Estados)
// ============================================================

const ESTADO_PREFIX = 'estado:';
const TTL_SEGUNDOS = 3600; // 1 hora

export interface EstadoContexto {
    step: string;
    dados: Record<string, any>;
}

export async function salvarEstado(whatsapp: string, estado: string, dadosExtras: any = null): Promise<void> {
    const client = getRedisCloudClient();
    const chave = `${ESTADO_PREFIX}${whatsapp}`;
    
    let dadosAtuais: Record<string, any> = {};
    
    // Se já existirem dados, mantemos eles para manter continuidade (CENÁRIO 10)
    const estadoExistente = await client.get(chave);
    if (estadoExistente) {
        try {
            const partes = estadoExistente.split('|');
            if (partes.length > 1) {
                dadosAtuais = JSON.parse(partes[1]);
            }
        } catch (e) {
            // Ignora erro de parsing, começa do zero
        }
    }

    // Faz merge dos dados novos com os existentes
    if (dadosExtras) {
        dadosAtuais = { ...dadosAtuais, ...dadosExtras };
    }

    const conteudo = dadosAtuais ? `${estado}|${JSON.stringify(dadosAtuais)}` : estado;

    try {
        await client.setex(chave, TTL_SEGUNDOS, conteudo);
        console.log(`[Redis Cloud] 💾 Estado salvo: ${whatsapp} -> ${estado} (TTL: ${TTL_SEGUNDOS}s)`, dadosAtuais);
    } catch (error) {
        console.error(`[Redis Cloud] ❌ Erro ao salvar estado: ${error}`);
        throw error;
    }
}

export async function lerEstado(whatsapp: string): Promise<{ estado: string | null, dados: any | null }> {
    const client = getRedisCloudClient();
    const chave = `${ESTADO_PREFIX}${whatsapp}`;

    try {
        const resultado = await client.get(chave);
        
        if (!resultado) {
            return { estado: null, dados: null };
        }

        // Separa o step dos dados
        const partes = resultado.split('|');
        const estado = partes[0];
        const dados = partes.length > 1 ? JSON.parse(partes[1]) : null;

        return { estado, dados };
    } catch (error) {
        console.error(`[Redis Cloud] ❌ Erro ao ler estado: ${error}`);
        return { estado: null, dados: null };
    }
}

export async function limparEstado(whatsapp: string): Promise<void> {
    const client = getRedisCloudClient();
    const chave = `${ESTADO_PREFIX}${whatsapp}`;

    try {
        await client.del(chave);
        console.log(`[Redis Cloud] 🧹 Estado limpo: ${whatsapp}`);
    } catch (error) {
        console.error(`[Redis Cloud] ❌ Erro ao limpar estado: ${error}`);
    }
}

export async function verificarConexao(): Promise<boolean> {
    try {
        const client = getRedisCloudClient();
        await client.ping();
        console.log(`[Redis Cloud] ✅ Conexão estabelecida`);
        return true;
    } catch (error) {
        console.error(`[Redis Cloud] ❌ Erro na conexão: ${error}`);
        return false;
    }
}
