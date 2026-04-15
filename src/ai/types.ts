export enum EstadosFluxo {
    IDLE = 'IDLE',
    AGUARDANDO_DADOS_PRODUTO = 'AGUARDANDO_DADOS_PRODUTO',
    AGUARDANDO_ACAO_SIMILARES = 'AGUARDANDO_ACAO_SIMILARES',
    AGUARDANDO_ACAO_PRODUTO_SELECIONADO = 'AGUARDANDO_ACAO_PRODUTO_SELECIONADO',
    AGUARDANDO_DADOS_OFERTA = 'AGUARDANDO_DADOS_OFERTA',
    AGUARDANDO_CONFIRMACAO_NOME = 'AGUARDANDO_CONFIRMACAO_NOME',
    AGUARDANDO_CONFIRMACAO_MULTIMODAL = 'AGUARDANDO_CONFIRMACAO_MULTIMODAL',
    AGUARDANDO_CONFIRMACAO_ALTERACOES = 'AGUARDANDO_CONFIRMACAO_ALTERACOES',
    AGUARDANDO_SELECAO_EDICAO = 'AGUARDANDO_SELECAO_EDICAO',
    AGUARDANDO_NOVO_PRECO_EDICAO = 'AGUARDANDO_NOVO_PRECO_EDICAO',
    AGUARDANDO_NOVO_NOME_EDICAO = 'AGUARDANDO_NOVO_NOME_EDICAO',
    
    // Estados de Onboarding (Sprint Auditoria)
    ONBOARDING_PERFIL = 'ONBOARDING_PERFIL',
    ONBOARDING_NOME = 'ONBOARDING_NOME',
    ONBOARDING_LOCALIZACAO = 'ONBOARDING_LOCALIZACAO',
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

export interface AlteracaoPlanejada {
    nome: string;
    precoFoto: number;
    unidade: string;
    acao: 'novo_cadastro' | 'preco_atualizado' | 'sem_alteracao' | 'ambiguo' | 'remover';
    produtoExistente?: {
        id: string;
        produto_nome: string;
        preco: number;
        unidade: string;
        updated_at?: string;
    };
    similares?: Array<{
        id: string;
        produto_nome: string;
        preco: number;
        unidade: string;
        updated_at?: string;
    }>;
}

export interface ContextoSessao {
    estado: EstadosFluxo;
    dadosProduto?: Partial<DadosProduto>;
    dadosOferta?: Partial<DadosOferta>;
    dadosLojista?: {
        nome?: string;
        cidade?: string;
        bairro?: string;
        estado?: string;
    };
    acao?: string;
    perguntaPendente?: string;
    termoBusca?: string;
    retries?: number;
    similaresEncontrados?: any[];
    itensPendenteConfirmacao?: any[];
    alteracoesPlanejadas?: AlteracaoPlanejada[];
}