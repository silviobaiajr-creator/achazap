import { parse } from 'csv-parse';
import { ai, GEMINI_MODEL } from '../lib/gemini.js';
import { logger } from '../lib/logger.js';
import { CSVMapeamentoSchema, type CSVMapeamento } from '../ai/schemas.js';
import { sendTextMessage, downloadMedia } from '../lib/whatsapp.js';
import { parseSafe } from '../ai/schemas.js';
import { pool } from '../lib/db.js';

export async function processarCSV(msg: any, from: string, loja: any, contexto: any): Promise<void> {
    const doc = msg.document;
    if (!doc?.id) {
        await sendTextMessage(from, '❌ Erro: Arquivo sem ID retornado pelo WhatsApp.');
        return;
    }

    try {
        // 1. Download do arquivo do WhatsApp
        const buffer = await downloadMedia(doc.id);
        const csvString = buffer.toString('utf-8');

        // Pega as primeiras linhas para amostragem
        const linhasAmostra = csvString.split('\n').filter(l => l.trim().length > 0).slice(0, 3).join('\n');

        // 2. Mapeamento Inteligente com Gemini
        const promptMapeamento = `Você é um engenheiro de dados integrando sistemas de supermercados.
Analise a seguinte amostra de arquivo CSV (cabeçalho + 2 linhas) e identifique quais colunas representam os dados principais.

Amostra:
${linhasAmostra}

Retorne APENAS um JSON dizendo o nome exato da coluna original (exatamente como está escrito no cabeçalho) para:
- coluna_nome (obrigatório)
- coluna_preco (obrigatório)
- coluna_unidade (opcional)
- coluna_sku (opcional)

Se não tiver unidade ou sku, retorne null.
JSON:`;

        const result = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: promptMapeamento,
            config: { responseMimeType: 'application/json' },
        });

        const mapa = parseSafe(CSVMapeamentoSchema, result.text || '{}', null as any);

        if (!mapa || !mapa.coluna_nome || !mapa.coluna_preco) {
            await sendTextMessage(from, '❌ Não consegui identificar as colunas de "Nome" e "Preço" neste CSV. Verifique seu arquivo e tente novamente.');
            return;
        }

        // 3. Parser do CSV
        let inseridos = 0;
        let erros = 0;

        await sendTextMessage(from, `🔍 Extração Iniciada! Colunas mapeadas:\nNome: ${mapa.coluna_nome}\nPreço: ${mapa.coluna_preco}\n\nLendo milhares de produtos, aguarde...`);

        parse(csvString, {
            columns: true,
            skip_empty_lines: true,
            trim: true,
            delimiter: [';', ',', '\t'] // Auto-detect separator
        }, async (err: any, records: any[]) => {
            if (err) {
                logger.error({ err, from }, '[CSV] Erro no parsing');
                await sendTextMessage(from, '❌ Ocorreu um erro ao quebrar o arquivo CSV.');
                return;
            }

            try {
                // Batch insert chunk logic for Postgres
                const client = await pool.connect();
                try {
                    await client.query('BEGIN');

                    // Batch inserts to be fast
                    for (const row of records) {
                        const nome    = row[mapa.coluna_nome];
                        let precoStr  = row[mapa.coluna_preco] || '0';
                        precoStr = precoStr.replace(',', '.');
                        const preco   = parseFloat(precoStr);
                        
                        const unidade = mapa.coluna_unidade ? (row[mapa.coluna_unidade] || 'un') : 'un';
                        const sku     = mapa.coluna_sku ? row[mapa.coluna_sku] : null;

                        if (nome && preco > 0) {
                            await client.query(
                                `INSERT INTO catalogo_historico 
                                (loja_id, produto_nome, produto_sku, preco, unidade, fonte_ingestao)
                                VALUES ($1, $2, $3, $4, $5, 'csv')`,
                                [loja.id, nome.substring(0, 250), sku, preco, unidade.substring(0, 30)]
                            );
                            inseridos++;
                        } else {
                            erros++;
                        }
                    }

                    await client.query('COMMIT');
                } catch (e) {
                    await client.query('ROLLBACK');
                    throw e;
                } finally {
                    client.release();
                }

                await sendTextMessage(from, `🎉 *Atualização concluída!*\n\n✅ ${inseridos} produtos novos registrados e blindados por 7 dias.\n⚠️ ${erros} ignorados (sem preço/nome válido).`);
            } catch (dbErr) {
                logger.error({ err: dbErr, from }, '[CSV] Erro db batch inserindo');
                await sendTextMessage(from, '❌ Erro crítico ao consolidar os milhares de produtos no banco. Reduza o arquivo e tente novamente.');
            }
        });

    } catch (err) {
        logger.error({ err, from }, '[CSV] Processamento falhou');
        await sendTextMessage(from, '❌ Erro interno ao processar CSV.');
    }
}
