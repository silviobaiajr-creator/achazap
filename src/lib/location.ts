/**
 * Mapeamento simplificado de DDDs brasileiros para Unidades da Federação (UF).
 */
const DDD_PARA_UF: Record<string, string> = {
    '11': 'SP', '12': 'SP', '13': 'SP', '14': 'SP', '15': 'SP', '16': 'SP', '17': 'SP', '18': 'SP', '19': 'SP',
    '21': 'RJ', '22': 'RJ', '24': 'RJ',
    '27': 'ES', '28': 'ES',
    '31': 'MG', '32': 'MG', '33': 'MG', '34': 'MG', '35': 'MG', '37': 'MG', '38': 'MG',
    '41': 'PR', '42': 'PR', '43': 'PR', '44': 'PR', '45': 'PR', '46': 'PR',
    '47': 'SC', '48': 'SC', '49': 'SC',
    '51': 'RS', '53': 'RS', '54': 'RS', '55': 'RS',
    '61': 'DF/GO', // Brasília
    '62': 'GO', '64': 'GO',
    '63': 'TO',
    '65': 'MT', '66': 'MT',
    '67': 'MS',
    '68': 'AC',
    '69': 'RO',
    '71': 'BA', '73': 'BA', '74': 'BA', '75': 'BA', '77': 'BA',
    '79': 'SE',
    '81': 'PE', '87': 'PE',
    '82': 'AL',
    '83': 'PB',
    '84': 'RN',
    '85': 'CE', '88': 'CE',
    '86': 'PI', '89': 'PI',
    '91': 'PA', '93': 'PA', '94': 'PA',
    '92': 'AM', '97': 'AM',
    '95': 'RR',
    '96': 'AP',
    '98': 'MA', '99': 'MA',
};

/**
 * Detecta o Estado (UF) a partir de um número de WhatsApp no formato E.164 (ex: 5591999999999).
 */
export function detectarEstadoPorWhatsApp(whatsapp: string): string | null {
    // Remove tudo que não for dígito
    const clean = whatsapp.replace(/\D/g, '');
    
    // Números brasileiros começam com 55
    if (!clean.startsWith('55') || clean.length < 12) return null;

    // O DDD são os dígitos 2 e 3 (ex: 55[91]...)
    const ddd = clean.substring(2, 4);
    
    return DDD_PARA_UF[ddd] || null;
}
