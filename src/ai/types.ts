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
    ONBOARDING_CATEGORIA = 'ONBOARDING_CATEGORIA',
    AGUARDANDO_SELECAO_REVISAO = 'AGUARDANDO_SELECAO_REVISAO',
    AGUARDANDO_QUANTIDADE_EMBALAGEM = 'AGUARDANDO_QUANTIDADE_EMBALAGEM', // Armadilha 11: fardo sem qtd
    
    // Estados do Consumidor
    ONBOARDING_CONSUMIDOR_LOCALIZACAO = 'ONBOARDING_CONSUMIDOR_LOCALIZACAO',
    CONSUMIDOR_IDLE = 'CONSUMIDOR_IDLE',
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
    fonte?: 'texto' | 'foto' | 'audio';
    produtoExistente?: {
        id: string;
        produto_nome: string;
        preco: number;
        unidade: string;
        atualizado_em?: string;
    };
    similares?: Array<{
        id: string;
        produto_nome: string;
        preco: number;
        unidade: string;
        atualizado_em?: string;
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
        categoria?: string;
    };
    dadosConsumidor?: {
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