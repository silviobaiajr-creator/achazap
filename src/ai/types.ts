export enum EstadosFluxo {
    IDLE = 'IDLE',
    AGUARDANDO_DADOS_PRODUTO = 'AGUARDANDO_DADOS_PRODUTO',
    AGUARDANDO_ACAO_SIMILARES = 'AGUARDANDO_ACAO_SIMILARES',
    AGUARDANDO_ACAO_PRODUTO_SELECIONADO = 'AGUARDANDO_ACAO_PRODUTO_SELECIONADO',
    AGUARDANDO_DADOS_OFERTA = 'AGUARDANDO_DADOS_OFERTA',
    AGUARDANDO_CONFIRMACAO_NOME = 'AGUARDANDO_CONFIRMACAO_NOME',
    AGUARDANDO_CONFIRMACAO_MULTIMODAL = 'AGUARDANDO_CONFIRMACAO_MULTIMODAL',
    AGUARDANDO_CONFIRMACAO_ALTERACOES = 'AGUARDANDO_CONFIRMACAO_ALTERACOES',
}

export interface DadosProduto {
    nome: string;
    preco: number;
    unidade: string;
}

export interface DadosOferta {
    valor_minimo: number;
    percentual: number;
    validade: string;
    produto_filtro?: string;
}

export interface ContextoSessao {
    estadoAtual: EstadosFluxo;
    dadosParciais: Partial<DadosProduto> | Partial<DadosOferta>;
    opcaoSelecionada?: number;
    termoBusca?: string;
}