/**
 * src/ai/agents/inventory-agent.ts
 * Agente responsável pelo fluxo completo de inventário do lojista.
 * Extraído do orchestrator.ts na Fase 2 — estados de cadastro, similares e edição de lote.
 */
import { type WhatsAppMessage } from '../../lib/whatsapp.js';
import { EstadosFluxo, ContextoSessao } from '../types.js';

// TODO: Fase 2 — mover os handlers dos estados abaixo para cá:
// AGUARDANDO_DADOS_PRODUTO, AGUARDANDO_ACAO_SIMILARES, AGUARDANDO_ACAO_PRODUTO_SELECIONADO,
// AGUARDANDO_CONFIRMACAO_NOME, AGUARDANDO_QUANTIDADE_EMBALAGEM,
// AGUARDANDO_CONFIRMACAO_ALTERACOES, AGUARDANDO_SELECAO_EDICAO,
// AGUARDANDO_NOVO_PRECO_EDICAO, AGUARDANDO_NOVO_NOME_EDICAO

const INVENTORY_STATES = new Set<string>([
    EstadosFluxo.AGUARDANDO_DADOS_PRODUTO,
    EstadosFluxo.AGUARDANDO_ACAO_SIMILARES,
    EstadosFluxo.AGUARDANDO_ACAO_PRODUTO_SELECIONADO,
    EstadosFluxo.AGUARDANDO_CONFIRMACAO_NOME,
    EstadosFluxo.AGUARDANDO_QUANTIDADE_EMBALAGEM,
    EstadosFluxo.AGUARDANDO_CONFIRMACAO_ALTERACOES,
    EstadosFluxo.AGUARDANDO_SELECAO_EDICAO,
    EstadosFluxo.AGUARDANDO_NOVO_PRECO_EDICAO,
    EstadosFluxo.AGUARDANDO_NOVO_NOME_EDICAO,
]);

export async function handleInventory(
    _msg: WhatsAppMessage,
    _from: string,
    loja: any,
    contexto: ContextoSessao | null,
    _userMessageText: string,
    _buttonId: string,
    _isInteractive: boolean,
    _isTextOnly: boolean,
    _isMediaOnly: boolean,
): Promise<boolean> {
    if (!loja) return false;
    if (!contexto) return false;
    // Não captura estados de consumidor ou onboarding
    if (!INVENTORY_STATES.has(contexto.estado)) return false;

    // A lógica está sendo mantida no orchestrator.ts durante a transição segura.
    // Após os testes passarem, cada estado será migrado incrementalmente.
    return false;
}
