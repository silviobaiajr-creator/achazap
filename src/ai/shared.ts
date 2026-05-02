/**
 * src/ai/shared.ts
 * Funções compartilhadas entre todos os Agentes do AchaZap.
 * Extraídas do orchestrator.ts na Fase 2 de Modularização.
 */

import {
    sendTextMessage,
    sendListMessage,
    type WhatsAppMessage,
} from '../lib/whatsapp.js';
import {
    limparContexto,
    cache,
    incrementarTokens,
    TOKEN_LIMITE_PREMIUM
} from '../lib/redis-cloud.js';
import { supabaseAdmin as supabase } from '../lib/supabase.js';
import { EstadosFluxo, ContextoSessao } from './types.js';
import { logger } from '../lib/logger.js';
import { detectarFugaNLP } from './skills/intent-detector.js';

const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

// ============================================================
// MENU PRINCIPAL
// ============================================================
const MENU_SECTIONS = [
    {
        title: 'Gestão de Estoque',
        rows: [
            { id: 'menu_cadastrar', title: 'Cadastrar/Atualizar', description: 'Adicionar ou atualizar produtos' },
            { id: 'menu_revisar',   title: 'Revisar Preços',      description: 'Ver preços desatualizados' },
        ],
    },
    {
        title: 'Vendas & Marketing',
        rows: [
            { id: 'menu_panfleto',   title: 'Oferta Relâmpago (⚡)', description: 'Destacar um produto SÓ HOJE' },
            { id: 'menu_ofertas',    title: 'Cupom Global',          description: 'Desconto p/ toda a loja' },
        ],
    },
    {
        title: 'Estatísticas',
        rows: [{ id: 'menu_estatisticas', title: 'Ver Estatísticas', description: 'Saldo de cliques e ranking' }],
    },
];

export async function enviarMenu(lojaNome: string, from: string): Promise<void> {
    const nomeSeguro = lojaNome.substring(0, 24);
    try {
        await sendListMessage(from, `Olá ${nomeSeguro}! O que você gostaria de fazer hoje?`, 'Escolha uma opção', MENU_SECTIONS);
    } catch (err: any) {
        logger.warn({ err: err?.message, from }, '[enviarMenu] Lista interativa falhou, enviando fallback texto');
        await sendTextMessage(
            from,
            `Olá ${nomeSeguro}! O que você gostaria de fazer?\n\n` +
            `1 - Cadastrar/Atualizar produto\n` +
            `2 - Revisar Preços\n` +
            `3 - Lançar Oferta Relâmpago (Panfleto)\n` +
            `4 - Criar Cupom Global\n` +
            `5 - Ver Estatísticas\n\n` +
            `Digite o número da opção desejada.`
        );
    }
}

// ============================================================
// PERFIL DA LOJA (com cache em memória)
// ============================================================
export async function buscarPerfilLoja(whatsapp: string) {
    const cacheKey = `loja:${whatsapp}`;

    try {
        const cached = cache.get(cacheKey);
        if (cached) return cached;
    } catch { /* ignora falha de cache */ }

    const whatsappNormalizado = whatsapp.replace(/\D/g, '');
    let { data } = await supabase
        .from('lojas')
        .select('id, nome, cidade, bairro, estado, saldo_cliques, ativa, plano')
        .eq('whatsapp', '+' + whatsappNormalizado)
        .single();

    if (!data) {
        ({ data } = await supabase
            .from('lojas')
            .select('id, nome, cidade, bairro, estado, saldo_cliques, ativa, plano')
            .eq('whatsapp', whatsappNormalizado)
            .single());
    }

    if (data) {
        if (data.plano === 'premium') {
            incrementarTokens(whatsapp, 0, TOKEN_LIMITE_PREMIUM);
        }
        try { cache.set(cacheKey, data, 300 * 1000); } catch { /* ignora */ }
    }
    return data ?? null;
}

// ============================================================
// EXECUTAR FUGA (Cancelamento Universal)
// ============================================================
export async function executarFuga(from: string, loja: any): Promise<void> {
    await limparContexto(from);
    await sendTextMessage(from, 'Sem problemas! Operação cancelada. 🧹 O que gostaria de fazer agora?');
    await delay(300);
    if (loja) {
        await enviarMenu(loja.nome, from);
    } else {
        await sendTextMessage(from, 'O que você está procurando hoje?');
    }
}

// ============================================================
// MIDDLEWARE GLOBAL DE FUGA (Sprint 6)
// ============================================================
const PALAVRAS_FUGA = /^(menu|cancelar|sair|voltar|reiniciar|cancela|cancela isso|para tudo|esquece|deixa pra lá|nem quero|não quero mais)$/i;
const IDS_BOTAO_FUGA = new Set(['btn_menu', 'btn_cancelar', 'acao_menu', 'menu_principal']);

export async function verificarFugaGlobal(
    msg: WhatsAppMessage,
    buttonId: string,
    userText: string,
    contexto: ContextoSessao | null,
    from: string,
    loja: any
): Promise<boolean> {
    const temContextoAtivo = contexto !== null && contexto.estado !== EstadosFluxo.IDLE;

    const estadosImunes = new Set([
        EstadosFluxo.ONBOARDING_PERFIL,
        EstadosFluxo.ONBOARDING_NOME,
        EstadosFluxo.ONBOARDING_LOCALIZACAO,
        EstadosFluxo.ONBOARDING_CATEGORIA,
        EstadosFluxo.ONBOARDING_CONSUMIDOR_LOCALIZACAO,
        EstadosFluxo.CONSUMIDOR_IDLE,
    ]);
    if (contexto && estadosImunes.has(contexto.estado)) return false;

    if (msg.type === 'interactive' && IDS_BOTAO_FUGA.has(buttonId)) {
        await executarFuga(from, loja);
        return true;
    }

    const isConfirmacaoInterna = buttonId.startsWith('confirmar_') || buttonId.startsWith('btn_sugestao');
    if (userText && PALAVRAS_FUGA.test(userText.trim()) && !isConfirmacaoInterna) {
        await executarFuga(from, loja);
        return true;
    }

    if (temContextoAtivo && userText && userText.length > 3 && !isConfirmacaoInterna) {
        const ehFuga = await detectarFugaNLP(userText);
        if (ehFuga) {
            await executarFuga(from, loja);
            return true;
        }
    }

    return false;
}
