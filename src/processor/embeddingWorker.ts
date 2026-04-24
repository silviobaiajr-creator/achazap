import { boss } from '../queue/pgBossClient.js';
import { logger } from '../lib/logger.js';
import { supabaseAdmin as supabase } from '../lib/supabase.js';
import { pool } from '../lib/db.js';
import { gerarEmbedding } from '../ai/skills/catalog-ledger.js';

const BATCH_SIZE = 10;

export async function startEmbeddingWorker() {
    await boss.work('sync-embeddings', async (args: any) => {
        const job = Array.isArray(args) ? args[0] : args;
        const { lojaId } = job.data as { lojaId?: string };
        logger.info({ lojaId, jobId: job.id }, '[EmbeddingWorker] Iniciando sincronização em background...');

        let totalAtualizados = 0;
        let hasMore = true;

        while (hasMore) {
            // Busca produtos sem embedding
            const client = await pool.connect();
            try {
                let query = `
                    SELECT id, produto_nome, especificacao, marca 
                    FROM catalogo_ativo 
                    WHERE embedding IS NULL AND disponivel = true
                `;
                const params: any[] = [];
                
                if (lojaId) {
                    query += ` AND loja_id = $1`;
                    params.push(lojaId);
                }
                
                query += ` LIMIT $${params.length + 1}`;
                params.push(BATCH_SIZE);

                const { rows } = await client.query(query, params);

                if (rows.length === 0) {
                    hasMore = false;
                    break;
                }

                // Gera embeddings em paralelo (com limite para não estourar a API)
                const updates = await Promise.all(
                    rows.map(async (row) => {
                        // Monta o texto rico para o embedding
                        const partes = [row.produto_nome];
                        if (row.marca) partes.push(row.marca);
                        if (row.especificacao) partes.push(row.especificacao);
                        const textoBusca = partes.join(' ');

                        const vetor = await gerarEmbedding(textoBusca);
                        return { id: row.id, vetor };
                    })
                );

                // Salva no banco
                for (const update of updates) {
                    if (update.vetor) {
                        await client.query(
                            `UPDATE catalogo_ativo SET embedding = $1 WHERE id = $2`,
                            [`[${update.vetor.join(',')}]`, update.id]
                        );
                        totalAtualizados++;
                    }
                }

                // Pequeno delay para aliviar a API do Gemini
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (err) {
                logger.error({ err }, '[EmbeddingWorker] Erro no lote de embeddings');
                hasMore = false; // aborta para tentar no próximo run
                throw err;
            } finally {
                client.release();
            }
        }

        logger.info({ totalAtualizados, lojaId }, '[EmbeddingWorker] Sincronização concluída');
    });
}
