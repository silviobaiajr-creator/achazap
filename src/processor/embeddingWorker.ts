import { boss } from '../queue/pgBossClient.js';
import { logger } from '../lib/logger.js';
import { pool } from '../lib/db.js';
import { gerarEmbedding, decomporProduto } from '../ai/skills/catalog-ledger.js';
import { logTokens } from '../lib/logger.js';
import { incrementarQuotaDB, verificarQuotaBloqueadaDB, QUOTA_WORKER_DIARIA } from '../lib/token-quota.js';

const BATCH_SIZE = 5;
const DELAY_ENTRE_ITENS_MS = 500;
const MAX_PRODUTOS_POR_JOB = 200;

export async function startEmbeddingWorker() {
    await boss.work('sync-embeddings', async (args: any) => {
        const job = Array.isArray(args) ? args[0] : args;
        const { lojaId } = job.data as { lojaId?: string };
        logger.info({ lojaId, jobId: job.id }, '[EmbeddingWorker] Iniciando sincronização em background...');

        // ── PROTEÇÃO #1: Verifica quota persistente ANTES de qualquer chamada ──
        // Diferente do MemoryCache, essa quota sobrevive a restarts do servidor.
        const quotaBloqueada = await verificarQuotaBloqueadaDB('worker', QUOTA_WORKER_DIARIA);
        if (quotaBloqueada) {
            logger.warn({ lojaId }, '[EmbeddingWorker] Quota diária já atingida — job encerrado sem custo.');
            return;
        }

        let totalEmbeddings = 0;
        let totalDecompostos = 0;
        let hasMore = true;
        let totalProcessados = 0;
        const idsFalhos = new Set<string>();

        while (hasMore) {
            const client = await pool.connect();
            try {
                // ── PROTEÇÃO #2: Query corrigida — critério restrito ──
                // Antes: "membro_core IS NULL OR (marca IS NULL AND csv)"
                //   → reprocessava todos os CSVs sem marca após cada restart
                // Agora: apenas "membro_core IS NULL OR embedding IS NULL"
                //   → após o primeiro processamento, nunca mais entra na fila
                let query = `
                    SELECT id, produto_nome, membro_core, marca, especificacao, unidade_medida, metadados
                    FROM catalogo_ativo
                    WHERE disponivel = true
                      AND (
                        embedding IS NULL
                        OR membro_core IS NULL
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

                if (rows.length === 0 || totalProcessados >= MAX_PRODUTOS_POR_JOB) {
                    if (totalProcessados >= MAX_PRODUTOS_POR_JOB) {
                        logger.warn({ lojaId, totalProcessados }, '[EmbeddingWorker] Limite de segurança atingido — encerrando job.');
                    }
                    hasMore = false;
                    break;
                }

                // ── PROTEÇÃO #3: Processamento + salvamento incremental ──
                // Antes: acumulava tudo em updates[], salvava no final do lote
                //   → se o servidor caísse no meio, nada era salvo e tudo rodava de novo
                // Agora: salva no banco IMEDIATAMENTE após cada produto processado
                for (const row of rows) {
                    // Verifica quota antes de cada chamada Gemini
                    if (await verificarQuotaBloqueadaDB('worker', QUOTA_WORKER_DIARIA)) {
                        logger.warn({ lojaId }, '[EmbeddingWorker] Quota atingida durante processamento — encerrando.');
                        hasMore = false;
                        break;
                    }

                    let { membro_core, marca, especificacao, unidade_medida, metadados } = row;
                    let decompostoAgora = false;
                    const sets: string[] = ['atualizado_em = now()'];
                    const vals: any[] = [];
                    let idx = 1;

                    // ── Decomposição (Gemini) ─────────────────────────────────────────
                    if (!membro_core) {
                        const camadas = await decomporProduto(row.produto_nome);
                        decompostoAgora = true;
                        membro_core    = membro_core    ?? camadas.membro_core;
                        marca          = marca          ?? camadas.marca;
                        especificacao  = especificacao  ?? camadas.especificacao;
                        unidade_medida = unidade_medida ?? camadas.unidade_medida;
                        if (camadas.metadados && !metadados) metadados = camadas.metadados;

                        // Contabiliza no banco (sobrevive a restart)
                        await incrementarQuotaDB('worker', 590, QUOTA_WORKER_DIARIA);

                        sets.push(`membro_core = $${idx++}`);
                        vals.push(membro_core);
                        sets.push(`marca = COALESCE(marca, $${idx++})`);
                        vals.push(marca);
                        sets.push(`especificacao = COALESCE(especificacao, $${idx++})`);
                        vals.push(especificacao);
                        sets.push(`unidade_medida = COALESCE(unidade_medida, $${idx++})`);
                        vals.push(unidade_medida);
                        if (metadados) {
                            sets.push(`metadados = COALESCE(metadados, $${idx++})`);
                            vals.push(JSON.stringify(metadados));
                        }

                        totalDecompostos++;
                        // Delay após cada chamada Gemini
                        await new Promise(resolve => setTimeout(resolve, DELAY_ENTRE_ITENS_MS));
                    }

                    // ── Embedding ─────────────────────────────────────────────────────
                    const partes = [row.produto_nome];
                    if (marca)         partes.push(marca);
                    if (especificacao) partes.push(especificacao);
                    const vetor = await gerarEmbedding(partes.join(' '));

                    if (vetor) {
                        sets.push(`embedding = $${idx++}`);
                        vals.push(`[${vetor.join(',')}]`);
                        await incrementarQuotaDB('worker', 10, QUOTA_WORKER_DIARIA);
                        totalEmbeddings++;
                    } else {
                        idsFalhos.add(row.id);
                    }

                    // ── Salva IMEDIATAMENTE no banco (incremental) ────────────────────
                    // Se o servidor cair aqui, este produto já está salvo e não será reprocessado.
                    vals.push(row.id);
                    await client.query(
                        `UPDATE catalogo_ativo SET ${sets.join(', ')} WHERE id = $${idx}`,
                        vals
                    );

                    totalProcessados++;
                }

                // Delay entre lotes
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (err) {
                logger.error({ err }, '[EmbeddingWorker] Erro no lote');
                hasMore = false;
                throw err;
            } finally {
                client.release();
            }
        }

        logger.info({ totalEmbeddings, totalDecompostos, totalProcessados, lojaId }, '[EmbeddingWorker] Sincronização concluída');

        // ── Disparo do Worker de Notificações em Real-Time ────────────────────
        // Após os embeddings estarem prontos, o NotificationWorker verifica se
        // algum consumidor tem alertas ativos que batem com os produtos processados.
        if (lojaId && totalProcessados > 0) {
            try {
                // Busca os produtos que acabaram de ser processados com seus preços e localização
                const client2 = await pool.connect();
                try {
                    const { rows: produtosProcessados } = await client2.query(
                        `SELECT ca.id, ca.produto_nome, ca.membro_core, ca.preco::float, ca.unidade,
                                l.cidade, l.bairro, l.estado, l.plano, l.nome AS loja_nome, l.whatsapp AS loja_whatsapp
                         FROM catalogo_ativo ca
                         JOIN lojas l ON l.id = ca.loja_id
                         WHERE ca.loja_id = $1
                           AND ca.disponivel = true
                           AND ca.atualizado_em >= now() - interval '10 minutes'
                         LIMIT 50`,
                        [lojaId]
                    );
                    if (produtosProcessados.length > 0) {
                        await boss.send('checar-alertas', { lojaId, produtos: produtosProcessados }, { retryLimit: 1 });
                        logger.info({ lojaId, qtd: produtosProcessados.length }, '[EmbeddingWorker] Job checar-alertas agendado.');
                    }
                } finally {
                    client2.release();
                }
            } catch (alertErr) {
                // Non-critical: falha no agendamento de alertas não deve travar o embeddingWorker
                logger.warn({ alertErr, lojaId }, '[EmbeddingWorker] Falha ao agendar checar-alertas (non-critical).');
            }
        }
    });
}
