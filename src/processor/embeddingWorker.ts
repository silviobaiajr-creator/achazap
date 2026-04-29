import { boss } from '../queue/pgBossClient.js';
import { logger } from '../lib/logger.js';
import { pool } from '../lib/db.js';
import { gerarEmbedding, decomporProduto } from '../ai/skills/catalog-ledger.js';

const BATCH_SIZE = 10;

export async function startEmbeddingWorker() {
    await boss.work('sync-embeddings', async (args: any) => {
        const job = Array.isArray(args) ? args[0] : args;
        const { lojaId } = job.data as { lojaId?: string };
        logger.info({ lojaId, jobId: job.id }, '[EmbeddingWorker] Iniciando sincronização em background...');

        let totalEmbeddings = 0;
        let totalDecompostos = 0;
        let hasMore = true;
        
        // Proteção contra Loop Infinito (Custo/Rate Limit):
        // Se a API falhar para um ID, ignoramos ele nas próximas buscas deste job
        const idsFalhos = new Set<string>();

        while (hasMore) {
            const client = await pool.connect();
            try {
                // Busca produtos que precisam de qualquer enriquecimento:
                // - embedding IS NULL       → precisa de gerarEmbedding()
                // - membro_core IS NULL     → precisa de decomporProduto() (não extraído ainda)
                // - marca IS NULL + csv     → PDV não tinha coluna_marca → precisa de decomporProduto()
                let query = `
                    SELECT id, produto_nome, membro_core, marca, especificacao, unidade_medida, metadados
                    FROM catalogo_ativo
                    WHERE disponivel = true
                      AND (
                        embedding IS NULL
                        OR membro_core IS NULL
                        OR (marca IS NULL AND fonte_ingestao = 'csv')
                      )
                `;
                const params: any[] = [];

                if (lojaId) {
                    query += ` AND loja_id = $${params.length + 1}`;
                    params.push(lojaId);
                }

                if (idsFalhos.size > 0) {
                    query += ` AND id != ALL($${params.length + 1})`;
                    params.push(Array.from(idsFalhos));
                }

                query += ` LIMIT $${params.length + 1}`;
                params.push(BATCH_SIZE);

                const { rows } = await client.query(query, params);

                if (rows.length === 0) {
                    hasMore = false;
                    break;
                }

                // Processa cada produto em paralelo dentro do lote
                const updates = await Promise.all(
                    rows.map(async (row) => {
                        let { membro_core, marca, especificacao, unidade_medida, metadados } = row;
                        let decompostoAgora = false;

                        // ── Decomposição: preenche campos NULL via Gemini ──────────────────
                        // Só chama se algum campo essencial estiver faltando
                        if (!membro_core || !marca) {
                            const camadas = await decomporProduto(row.produto_nome);
                            decompostoAgora = true;

                            // Prioridade: valor existente no banco > valor extraído pelo Gemini
                            membro_core    = membro_core    ?? camadas.membro_core;
                            marca          = marca          ?? camadas.marca;
                            especificacao  = especificacao  ?? camadas.especificacao;
                            unidade_medida = unidade_medida ?? camadas.unidade_medida;

                            // Mescla metadados sem sobrescrever o que já existe
                            if (camadas.metadados && !metadados) {
                                metadados = camadas.metadados;
                            }
                        }

                        // ── Embedding: texto enriquecido com campos de decomposição ────────
                        const partes = [row.produto_nome];
                        if (marca)         partes.push(marca);
                        if (especificacao) partes.push(especificacao);
                        const textoBusca = partes.join(' ');
                        const vetor = await gerarEmbedding(textoBusca);

                        return { id: row.id, vetor, membro_core, marca, especificacao, unidade_medida, metadados, decompostoAgora };
                    })
                );

                // Salva no banco
                for (const u of updates) {
                    const sets: string[] = ['atualizado_em = now()'];
                    const vals: any[] = [];
                    let idx = 1;

                    if (u.vetor) {
                        sets.push(`embedding = $${idx++}`);
                        vals.push(`[${u.vetor.join(',')}]`);
                    }

                    if (u.decompostoAgora) {
                        // membro_core: sempre atualiza (é o campo principal da decomposição)
                        sets.push(`membro_core = $${idx++}`);
                        vals.push(u.membro_core);

                        // Demais campos: COALESCE para não sobrescrever valor que o PDV já forneceu
                        sets.push(`marca = COALESCE(marca, $${idx++})`);
                        vals.push(u.marca);

                        sets.push(`especificacao = COALESCE(especificacao, $${idx++})`);
                        vals.push(u.especificacao);

                        sets.push(`unidade_medida = COALESCE(unidade_medida, $${idx++})`);
                        vals.push(u.unidade_medida);

                        if (u.metadados) {
                            sets.push(`metadados = COALESCE(metadados, $${idx++})`);
                            vals.push(JSON.stringify(u.metadados));
                        }

                        totalDecompostos++;
                    }

                    vals.push(u.id);
                    await client.query(
                        `UPDATE catalogo_ativo SET ${sets.join(', ')} WHERE id = $${idx}`,
                        vals
                    );
                    
                    if (u.vetor) {
                        totalEmbeddings++;
                    } else {
                        // Se não gerou vetor (falha na API), adiciona aos falhos para evitar loop infinito
                        idsFalhos.add(u.id);
                    }
                }

                // Delay para respeitar rate limit da API (lotes de 10 com 1s de intervalo)
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (err) {
                logger.error({ err }, '[EmbeddingWorker] Erro no lote');
                hasMore = false;
                throw err;
            } finally {
                client.release();
            }
        }

        logger.info({ totalEmbeddings, totalDecompostos, lojaId }, '[EmbeddingWorker] Sincronização concluída');
    });
}
