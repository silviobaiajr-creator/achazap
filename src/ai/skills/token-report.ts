import { supabaseAdmin as supabase } from '../../lib/supabase.js';
import { logger } from '../../lib/logger.js';

// Preços Estimados Gemini 1.5 Flash (Base Abril 2026)
// $0.075 / 1M tokens (Entrada) | $0.30 / 1M tokens (Saída)
// Câmbio Estável: 1 USD = 5.20 BRL
const PRECO_ENTRADA_1M = 0.075;
const PRECO_SAIDA_1M = 0.30;
const CAMBIO_BRL = 5.20;

export async function gerarRelatorioTokens(dias: number = 7) {
    try {
        let relatorioCompleto = `📊 *Relatório de Consumo (Últimos ${dias} dias)*\n`;
        relatorioCompleto += `───────────────────\n\n`;

        for (let i = 0; i < dias; i++) {
            const dataAlvo = new Date();
            dataAlvo.setDate(dataAlvo.getDate() - i);
            const dataStr = dataAlvo.toISOString().split('T')[0];

            const resumoDia = await gerarResumoDia(dataStr);
            relatorioCompleto += resumoDia;
            if (i < dias - 1) relatorioCompleto += `\n───────────────────\n\n`;
        }

        return relatorioCompleto;
    } catch (e) {
        logger.error({ e }, '[TokenReport] Erro ao gerar relatório 7 dias');
        return '❌ Erro ao gerar relatório detalhado.';
    }
}

async function gerarResumoDia(data: string) {
    const { data: logs, error } = await supabase
        .from('logs_dev')
        .select('whatsapp, dados')
        .eq('contexto', 'GEMINI_COST')
        .gte('created_at', `${data}T00:00:00.000Z`)
        .lte('created_at', `${data}T23:59:59.999Z`);

    if (error || !logs) return `📅 *${data}*: Erro ao acessar logs.`;
    if (logs.length === 0) return `📅 *${data}*: Sem consumo registrado.`;

    let tEntrada = 0;
    let tSaida = 0;
    const porUsuario = new Map<string, number>();

    for (const log of logs) {
        const d = log.dados as any;
        const entrada = d?.tokens_entrada || 0;
        const saida = d?.tokens_saida || 0;
        tEntrada += entrada;
        tSaida += saida;
        
        const totalLog = entrada + saida;
        const atual = porUsuario.get(log.whatsapp) || 0;
        porUsuario.set(log.whatsapp, atual + totalLog);
    }

    // Cálculo de Custo Estimado
    // (Tokens / 1.000.000) * Preço * Câmbio
    const custoUSD = ((tEntrada / 1000000) * PRECO_ENTRADA_1M) + ((tSaida / 1000000) * PRECO_SAIDA_1M);
    const custoBRL = custoUSD * CAMBIO_BRL;

    const sortedUsers = Array.from(porUsuario.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3);

    let report = `📅 *${data}*\n`;
    report += `• Chamadas: ${logs.length}\n`;
    report += `• Tokens: ${(tEntrada + tSaida).toLocaleString('pt-BR')}\n`;
    report += `• Custo Est.: *R$ ${custoBRL.toFixed(4).replace('.', ',')}*\n`;
    report += `• Top Usuários:\n`;
    for (const [user, total] of sortedUsers) {
        report += `  └ ${user.slice(-4)}: ${total.toLocaleString('pt-BR')} tks\n`;
    }

    return report;
}
