/**
 * src/ai/agents/onboarding-agent.ts
 * Agente responsável por todo o fluxo de cadastro inicial:
 * - Detecção de novo número (Lojista ou Consumidor)
 * - Coleta de Nome, Cidade, Bairro, Categoria
 * - Persistência da loja no Supabase
 *
 * Retorna true se consumiu a mensagem, false se ela não era do domínio de Onboarding.
 */

import {
    sendTextMessage,
    sendInteractiveButtons,
    sendListMessage,
    type WhatsAppMessage,
} from '../../lib/whatsapp.js';
import { salvarContexto, limparContexto } from '../../lib/redis-cloud.js';
import { supabaseAdmin as supabase } from '../../lib/supabase.js';
import { EstadosFluxo, ContextoSessao } from '../types.js';
import { logger, criarLoggerConversa } from '../../lib/logger.js';
import { enviarMenu } from '../shared.js';

const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

const CATEGORIAS_MENU = [
    {
        title: 'Mais Comuns',
        rows: [
            { id: 'cat_supermercado', title: 'Supermercado',    description: 'Mercadinhos, Mercearias' },
            { id: 'cat_farmacia',     title: 'Farmácia',        description: 'Drogarias' },
            { id: 'cat_restaurante',  title: 'Alimentação',     description: 'Refeições, Lanches, Pizza' },
            { id: 'cat_padaria',      title: 'Padaria/Açougue', description: 'Pães, Carnes, Frios' },
            { id: 'cat_vestuario',    title: 'Moda/Calçados',   description: 'Roupas, Sapatos' },
        ],
    },
    {
        title: 'Outros Setores',
        rows: [
            { id: 'cat_construcao',  title: 'Construção',  description: 'Ferragens, Tintas' },
            { id: 'cat_pet',         title: 'Pet Shop',    description: 'Ração, Acessórios' },
            { id: 'cat_eletronicos', title: 'Eletrônicos', description: 'Celulares, TV, PC' },
            { id: 'cat_utilidades',  title: 'Utilidades',  description: 'Cosméticos, Variedades' },
            { id: 'cat_outro',       title: 'Outro',       description: 'Outras opções' },
        ],
    },
];

export async function handleOnboarding(
    msg: WhatsAppMessage,
    from: string,
    loja: any,
    contexto: ContextoSessao | null,
    userText: string,
    buttonId: string,
    setLoja: (l: any) => void
): Promise<boolean> {

    // Se a loja já existe, este agente não tem nada a fazer
    if (loja) return false;

    // ── Verificar se é consumidor já cadastrado ───────────────────────────────
    let usuario = null;
    if (!loja && (!contexto || contexto.estado === EstadosFluxo.IDLE)) {
        const whatsappComPlus = from.startsWith('+') ? from : '+' + from;
        const { data } = await supabase
            .from('usuarios')
            .select('*')
            .eq('whatsapp', whatsappComPlus)
            .maybeSingle();
        usuario = data;
    }

    // Consumidor já cadastrado → não é Onboarding de lojista, passa adiante
    if (usuario) return false;

    // ── Novo número sem loja nem conta de consumidor ──────────────────────────
    const ESTADOS_ONBOARDING = new Set([
        EstadosFluxo.ONBOARDING_PERFIL,
        EstadosFluxo.ONBOARDING_NOME,
        EstadosFluxo.ONBOARDING_LOCALIZACAO,
        EstadosFluxo.ONBOARDING_CATEGORIA,
        EstadosFluxo.ONBOARDING_CONSUMIDOR_LOCALIZACAO,
    ]);

    // Se não há contexto de onboarding ativo: inicia boas-vindas
    if (!contexto || (!ESTADOS_ONBOARDING.has(contexto.estado) && contexto.estado !== EstadosFluxo.CONSUMIDOR_IDLE)) {
        logger.info({ from }, '[OnboardingAgent] Novo número. Iniciando dispatcher.');
        await salvarContexto(from, { estado: EstadosFluxo.ONBOARDING_PERFIL });
        await sendInteractiveButtons(from,
            'Olá! Eu sou o *AchaZap*, seu assistente inteligente para vender mais rápido e encontrar as melhores ofertas do bairro. 🚀\n\nComo posso te ajudar agora?',
            [
                { id: 'perf_lojista',    title: '📦 Sou Lojista' },
                { id: 'perf_consumidor', title: '🛍️ Quero Comprar' },
            ]
        );
        return true;
    }

    // ── ONBOARDING_PERFIL: Escolha de Perfil ─────────────────────────────────
    if (contexto.estado === EstadosFluxo.ONBOARDING_PERFIL) {
        if (buttonId === 'perf_lojista') {
            await salvarContexto(from, { ...contexto, estado: EstadosFluxo.ONBOARDING_NOME });
            await sendTextMessage(from, 'Excelente! 🚀 Vamos cadastrar sua loja.\n\nQual o *Nome da sua Loja*?');
            return true;
        }
        if (buttonId === 'perf_consumidor') {
            await salvarContexto(from, { ...contexto, estado: EstadosFluxo.ONBOARDING_CONSUMIDOR_LOCALIZACAO });
            await sendTextMessage(from, 'Ótimo! 🛍️ Para te mostrar as melhores ofertas perto de você, qual a sua *Cidade, Estado e Bairro*?\n\nEx: Portel, PA, Centro');
            return true;
        }
        await sendInteractiveButtons(from, 'Por favor, selecione uma das opções abaixo:', [
            { id: 'perf_lojista',    title: '📦 Sou Lojista' },
            { id: 'perf_consumidor', title: '🛍️ Quero Comprar' },
        ]);
        return true;
    }

    // ── ONBOARDING_NOME: Nome da Loja ─────────────────────────────────────────
    if (contexto.estado === EstadosFluxo.ONBOARDING_NOME) {
        if (!userText || userText.length < 3) {
            await sendTextMessage(from, 'Por favor, digite um nome válido para sua loja (mínimo 3 letras).');
            return true;
        }
        await salvarContexto(from, {
            ...contexto,
            estado: EstadosFluxo.ONBOARDING_LOCALIZACAO,
            dadosLojista: { nome: userText },
        });
        await sendTextMessage(from, `Legal, *${userText}*!\n\nAgora, qual a sua *Cidade, Estado e Bairro*?\nEx: Portel, PA, Centro`);
        return true;
    }

    // ── ONBOARDING_LOCALIZACAO: Cidade, Estado e Bairro do Lojista ───────────
    if (contexto.estado === EstadosFluxo.ONBOARDING_LOCALIZACAO) {
        const extraidos = userText.split(',').map(s => s.trim());
        if (extraidos.length < 3) {
            await sendTextMessage(from, 'Para melhor precisão, envie sua Cidade, Estado e Bairro separados por vírgula.\nEx: Portel, PA, Centro');
            return true;
        }
        const [cidade, estado, bairro] = extraidos;
        await salvarContexto(from, {
            ...contexto,
            estado: EstadosFluxo.ONBOARDING_CATEGORIA,
            dadosLojista: { ...contexto.dadosLojista, cidade, estado, bairro },
        });
        await sendListMessage(from, 'Show! Para finalizar, qual a *Categoria* da sua loja?', 'Escolha a categoria', CATEGORIAS_MENU);
        return true;
    }

    // ── ONBOARDING_CONSUMIDOR_LOCALIZACAO ────────────────────────────────────
    if (contexto.estado === EstadosFluxo.ONBOARDING_CONSUMIDOR_LOCALIZACAO) {
        const extraidos = userText.split(',').map(s => s.trim());
        if (extraidos.length < 3) {
            await sendTextMessage(from, 'Para encontrar as melhores ofertas, preciso da sua Cidade, Estado e Bairro separados por vírgula.\nEx: Portel, PA, Centro');
            return true;
        }
        const [cidade, estado, bairro] = extraidos;

        try {
            const { error } = await supabase.from('usuarios').upsert(
                { whatsapp: from.startsWith('+') ? from : '+' + from, cidade, bairro, estado },
                { onConflict: 'whatsapp' }
            );
            if (error) throw error;
        } catch (err) {
            logger.error({ err }, '[OnboardingAgent] Erro ao cadastrar consumidor');
        }

        await salvarContexto(from, {
            ...contexto,
            estado: EstadosFluxo.CONSUMIDOR_IDLE,
            dadosConsumidor: { ...contexto.dadosConsumidor, cidade, bairro, estado },
        });
        await sendTextMessage(from, `🎉 Perfeito! A partir de agora, o AchaZap vai procurar ofertas em *${cidade}*.\n\nO que você quer comprar hoje?\nEx: *"Onde tem Picanha?"* ou *"Pizza"*`);
        return true;
    }

    // ── ONBOARDING_CATEGORIA: Cadastro Final da Loja ─────────────────────────
    if (contexto.estado === EstadosFluxo.ONBOARDING_CATEGORIA) {
        const categoriaKey = buttonId.startsWith('cat_') ? buttonId.replace('cat_', '') : '';
        if (!categoriaKey) {
            await sendTextMessage(from, 'Por favor, selecione uma categoria da lista para continuarmos.');
            return true;
        }

        try {
            const { data: novaLoja, error } = await supabase
                .from('lojas')
                .insert({
                    whatsapp:      from.startsWith('+') ? from : '+' + from,
                    nome:          contexto.dadosLojista?.nome,
                    cidade:        contexto.dadosLojista?.cidade,
                    bairro:        contexto.dadosLojista?.bairro,
                    estado:        contexto.dadosLojista?.estado,
                    categoria:     categoriaKey,
                    ativa:         true,
                    saldo_cliques: 100,
                })
                .select()
                .single();

            if (error) throw error;

            await sendTextMessage(from,
                `🎉 Tudo pronto, *${contexto.dadosLojista?.nome}*!\n\n` +
                `Sua loja foi cadastrada como *${categoriaKey.toUpperCase()}* em *${contexto.dadosLojista?.cidade}*.\n` +
                `Você ganhou *100 cliques de bônus* para começar! 🎁`
            );
            await delay(800);
            await sendTextMessage(from,
                `📦 *Agora vamos montar seu catálogo!*\n\n` +
                `Você pode cadastrar seus produtos de 3 formas:\n\n` +
                `📷 *Foto* — Mande a foto de um produto ou de um encarte inteiro!\n` +
                `🎙️ *Áudio* — Me mande um áudio falando o nome e o preço.\n` +
                `✍️ *Texto* — Digite direto. Ex: _Feijão Carioca 8,50_\n\n` +
                `Comece agora! Quanto mais produtos, mais clientes vão te encontrar. 🚀`
            );
            await delay(500);
            await limparContexto(from);

            // Propaga a loja recém-criada para o orquestrador
            setLoja(novaLoja);
        } catch (err: any) {
            const childLogger = criarLoggerConversa(from, contexto.estado);
            childLogger.error({ err }, '[OnboardingAgent] Erro ao salvar loja');
            await sendTextMessage(from, 'Vish, tive um probleminha técnico ao salvar sua loja. Verifique os dados ou tente novamente mais tarde.');
        }
        return true;
    }

    return false;
}
