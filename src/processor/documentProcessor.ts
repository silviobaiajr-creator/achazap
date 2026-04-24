import { parse } from 'csv-parse';
import * as xlsx from 'xlsx';
import { ai, GEMINI_MODEL } from '../lib/gemini.js';
import { logger } from '../lib/logger.js';
import { CSVMapeamentoSchema } from '../ai/schemas.js';
import { sendTextMessage, downloadMedia, sendInteractiveButtons } from '../lib/whatsapp.js';
import { parseSafe } from '../ai/schemas.js';
import { pool } from '../lib/db.js';
import { limparContexto } from '../lib/redis-cloud.js';
import { decomporProduto } from '../ai/skills/catalog-ledger.js';

// ─── Constantes de Segurança ──────────────────────────────────────────────────
const CHUNK_SIZE         = 5000;
const MAX_FILE_BYTES     = 5 * 1024 * 1024;
const MAX_PROMPT_SAMPLE  = 500;
const CHUNK_TIMEOUT_MS   = 300_000;

function maskPhone(phone: string): string {
    if (phone.length <= 6) return '***';
    return phone.slice(0, 4) + '*'.repeat(phone.length - 8) + phone.slice(-4);
}

function hashLojaId(uuid: string): number {
    const hex = uuid.replace(/-/g, '').substring(0, 15);
    return parseInt(hex, 16) % Number.MAX_SAFE_INTEGER;
}

function sanitizeSample(raw: string): string {
    return raw
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
        .replace(/ignore\s+(as\s+)?instru[çc][õo]es/gi, '[REMOVED]')
        .replace(/forget\s+(the\s+)?previous/gi, '[REMOVED]')
        .replace(/<\/?[^>]+>/g, '')
        .substring(0, MAX_PROMPT_SAMPLE);
}

// Magic bytes de formatos permitidos e proibidos
const EXCEL_MAGIC: [number, number[]][] = [
    [0, [0x50, 0x4B, 0x03, 0x04]], // XLSX/XLSM (ZIP based)
    [0, [0xD0, 0xCF, 0x11, 0xE0]], // XLS (Legacy OLE2)
];

const FORBIDDEN_MAGIC: [number, number[]][] = [
    [0, [0x25, 0x50, 0x44, 0x46]], // PDF
    [0, [0x89, 0x50, 0x4E, 0x47]], // PNG
    [0, [0xFF, 0xD8, 0xFF]],       // JPEG
];

function isForbiddenBinary(buf: Buffer): boolean {
    for (const [offset, magic] of FORBIDDEN_MAGIC) {
        if (magic.every((byte, i) => buf[offset + i] === byte)) return true;
    }
    return false;
}

function isExcel(buf: Buffer): boolean {
    for (const [offset, magic] of EXCEL_MAGIC) {
        if (magic.every((byte, i) => buf[offset + i] === byte)) return true;
    }
    return false;
}

// ─── Parsers ──────────────────────────────────────────────────────────────────

function parseCsvToRecords(csvString: string): Promise<any[]> {
    return new Promise((resolve, reject) => {
        parse(
            csvString,
            {
                columns: true,
                skip_empty_lines: true,
                trim: true,
                delimiter: [';', ',', '\t'],
                to: 50_000,
            },
            (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            }
        );
    });
}

function parseExcelToRecords(buffer: Buffer): any[] {
    const workbook = xlsx.read(buffer, { type: 'buffer' });
    const firstSheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[firstSheetName];
    return xlsx.utils.sheet_to_json(worksheet, { defval: null });
}

async function queryWithTimeout<T>(
    fn: () => Promise<T>,
    timeoutMs: number = CHUNK_TIMEOUT_MS,
    label: string
): Promise<T> {
    return Promise.race([
        fn(),
        new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`[DOC] Timeout: ${label} excedeu ${timeoutMs}ms`)), timeoutMs)
        ),
    ]);
}

// ─── Processador Principal ──────────────────────────────────────────────────
export async function processarDocumento(msg: any, from: string, loja: any, _contexto: any): Promise<void> {
    const masked = maskPhone(from);
    const doc = msg.document;

    if (!doc?.id) {
        await sendTextMessage(from, '❌ Erro: Arquivo sem ID.');
        return;
    }

    const fileSizeBytes: number | undefined = (doc as any).file_size;
    const isTestBypass = process.env.ALLOW_LARGE_CSV === 'true';

    if (!isTestBypass && fileSizeBytes !== undefined && fileSizeBytes > MAX_FILE_BYTES) {
        await sendTextMessage(from, `❌ Arquivo muito grande. O limite máximo é de ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
        return;
    }

    try {
        const buffer = await downloadMedia(doc.id);

        if (!isTestBypass && buffer.length > MAX_FILE_BYTES) {
            await sendTextMessage(from, `❌ Arquivo excede o limite de ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
            return;
        }

        if (isForbiddenBinary(buffer)) {
            await sendTextMessage(from, '❌ O arquivo enviado (PDF/Imagem) não é suportado. Envie Excel ou CSV.');
            return;
        }

        const eExcel = isExcel(buffer) || doc.filename?.match(/\.xlsx$|\.xlsm$|\.xls$/i);
        let records: any[] = [];
        let amostraParaGemini = '';

        if (eExcel) {
            logger.info({ from: masked }, '[DOC] Processando Excel');
            records = parseExcelToRecords(buffer);
            amostraParaGemini = JSON.stringify(records.slice(0, 3));
        } else {
            logger.info({ from: masked }, '[DOC] Processando CSV');
            const csvString = buffer.toString('utf-8');
            records = await parseCsvToRecords(csvString);
            amostraParaGemini = csvString.split('\n').slice(0, 3).join('\n');
        }

        if (records.length === 0) {
            await sendTextMessage(from, '⚠️ O arquivo não contém linhas de dados válidas.');
            return;
        }

        // Mapeamento Gemini: identifica colunas E decompõe os dados nas 6 camadas
        const amostraSanitizada = sanitizeSample(amostraParaGemini);
        const promptMapeamento = `Você é um engenheiro de dados de supermercado. Analise a amostra de arquivo de produtos abaixo.
Amostra:
${amostraSanitizada}

Tarefa 1 — Identificar as colunas do arquivo para mapear em nosso sistema:
- coluna_nome (obrigatório): Nome ou descrição do produto.
- coluna_preco (obrigatório): Preço de venda.
- coluna_unidade (opcional): Unidade (un, kg, fardo, etc.).
- coluna_sku (opcional): Código EAN, Barcode ou ID interno.
- coluna_marca (opcional): Marca do fabricante.
- coluna_categoria (opcional): Departamento ou categoria.
- coluna_estoque (opcional): Quantidade em estoque.

Retorne APENAS o JSON mapeando os nomes reais das colunas encontradas na amostra para nossas chaves:
{"coluna_nome":"...","coluna_preco":"...","coluna_unidade":null,"coluna_sku":null,"coluna_marca":null,"coluna_categoria":null,"coluna_estoque":null}

JSON:`;

        const result = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: promptMapeamento,
            config: { responseMimeType: 'application/json' },
        });

        const mapa = parseSafe(CSVMapeamentoSchema, result.text || '{}', null as any);

        if (!mapa?.coluna_nome || !mapa?.coluna_preco) {
            await sendTextMessage(from, '❌ Não identifiquei as colunas de "Nome" e "Preço". Verifique o cabeçalho e tente novamente.');
            return;
        }

        await sendTextMessage(from, `🔍 ${eExcel ? 'Excel' : 'CSV'} detectado!\nLendo: *${records.length}* itens...`);

        const lojaLockKey = hashLojaId(loja.id);
        let inseridos = 0, atualizados = 0, ignorados = 0, semAlteracao = 0;
        const amostraAtualizados: string[] = [];

        const client = await pool.connect();
        try {
            // ── Lock por loja (evita upload duplo simultâneo) ─────────────────
            await client.query('BEGIN');
            const { rows: lockRows } = await client.query('SELECT pg_try_advisory_xact_lock($1) AS acq', [lojaLockKey]);
            if (!lockRows[0]?.acq) {
                await client.query('ROLLBACK');
                await sendTextMessage(from, '⚠️ Outro upload em andamento. Aguarde.');
                return;
            }
            await client.query('COMMIT');

            // ── STATEFUL CHECK: carrega estado atual do catálogo em memória ───────────────────────
            // catalogo_ativo têm 1 linha por produto: sem DISTINCT ON, sem sort custoso.
            // Uma única query substitui N consultas dentro dos chunks.
            const { rows: catalogoAtual } = await client.query<{
                id: string;
                produto_nome: string;
                produto_sku: string | null;
                preco: string;
                unidade: string;
            }>(
                `SELECT id, produto_nome, produto_sku, preco::text, unidade
                 FROM catalogo_ativo
                 WHERE loja_id = $1 AND disponivel = true`,
                [loja.id]
            );

            // Mapas de lookup O(1) — chave normalizada para lowercase sem espaços extras
            const mapaPorSku  = new Map<string, { id: string; preco: number }>(); // sku  → {id, preço_atual}
            const mapaPorNome = new Map<string, { id: string; preco: number }>(); // nome → {id, preço_atual}
            for (const r of catalogoAtual) {
                const precoAtual = parseFloat(r.preco);
                if (r.produto_sku) mapaPorSku.set(r.produto_sku.trim().toLowerCase(),  { id: r.id, preco: precoAtual });
                mapaPorNome.set(r.produto_nome.trim().toLowerCase(), { id: r.id, preco: precoAtual });
            }

            // ── Processamento em chunks com Bulk INSERT ───────────────────────
            // Set de fingerprints intra-upload para evitar duplicatas dentro do próprio arquivo
            const insertedThisRun = new Set<string>();

            for (let offset = 0; offset < records.length; offset += CHUNK_SIZE) {
                const chunk = records.slice(offset, offset + CHUNK_SIZE);
                await queryWithTimeout(async () => {
                    const linhasNovas: any[] = [];

                    for (const row of chunk) {
                        const nome  = String(row[mapa.coluna_nome] || '').trim();
                        const preco = parseFloat(String(row[mapa.coluna_preco] || '0').replace(',', '.'));
                        const unidade = mapa.coluna_unidade ? String(row[mapa.coluna_unidade] || 'un').trim() : 'un';
                        const sku     = mapa.coluna_sku ? String(row[mapa.coluna_sku] ?? '').trim() || null : null;
                        const marca_planilha = mapa.coluna_marca ? String(row[mapa.coluna_marca] ?? '').trim() || null : null;
                        const categoria      = mapa.coluna_categoria ? String(row[mapa.coluna_categoria] ?? '').trim() || null : null;
                        const estoque        = mapa.coluna_estoque ? String(row[mapa.coluna_estoque] ?? '').trim() || null : null;

                        if (!nome || !preco || preco <= 0) { ignorados++; continue; }

                        const nomeNorm = nome.toLowerCase();
                        const skuNorm  = sku ? sku.toLowerCase() : null;

                        // ── Delta Check: SKU tem prioridade, depois Nome ───────────────────────
                        const entradaPorSku  = skuNorm  ? mapaPorSku.get(skuNorm)   : undefined;
                        const entradaPorNome = mapaPorNome.get(nomeNorm);
                        const entrada        = entradaPorSku ?? entradaPorNome;
                        const precoAtual     = entrada?.preco;
                        const produtoId      = entrada?.id ?? null;

                        const isNovo       = precoAtual === undefined;
                        const precoMudou   = precoAtual !== undefined && Math.abs(precoAtual - preco) > 0.001;

                        if (!isNovo && !precoMudou) {
                            semAlteracao++;
                            continue; // Mesmo produto, mesmo preço — não polui o banco
                        }

                        // Deduplica dentro do mesmo arquivo (ex: SKU repetido na planilha)
                        const fp = skuNorm ?? nomeNorm;
                        if (insertedThisRun.has(fp)) continue;
                        insertedThisRun.add(fp);

                        // Atualiza mapa em memória p/ detecções subsequentes no mesmo upload
                        if (skuNorm)  mapaPorSku.set(skuNorm, { id: produtoId ?? '', preco });
                        mapaPorNome.set(nomeNorm, { id: produtoId ?? '', preco });

                        linhasNovas.push({
                            row: [
                                loja.id,
                                nome.substring(0, 250),
                                sku,
                                preco,
                                unidade.substring(0, 30),
                                'csv',
                            ],
                            extra: { marca_planilha, categoria, estoque }
                        });

                        if (isNovo) {
                            inseridos++;
                        } else {
                            atualizados++;
                            if (amostraAtualizados.length < 10 && precoAtual !== undefined) {
                                const pAntigo = precoAtual.toFixed(2).replace('.', ',');
                                const pNovo = preco.toFixed(2).replace('.', ',');
                                amostraAtualizados.push(`• ${nome}: R$ ${pAntigo} ➔ *R$ ${pNovo}*`);
                            }
                        }
                    }

                    // Decompõe os novos produtos em 6 camadas em paralelo (antes de gravar)
                    const linhasComCamadas = await Promise.all(
                        linhasNovas.map(async (item: any) => {
                            const { row, extra } = item;
                            const camadas = await decomporProduto(row[1]); // row[1] = produto_nome
                            
                            // 💡 Inteligência Híbrida: Prioriza a Marca da planilha se detectada
                            if (extra.marca_planilha) {
                                camadas.marca = extra.marca_planilha.substring(0, 100);
                            }
                            
                            // 📥 Preservação de Dados: Categoria e Estoque vão para Metadados (JSONB)
                            const metadados = camadas.metadados || {};
                            if (extra.categoria) metadados.categoria_planilha = extra.categoria;
                            if (extra.estoque)   metadados.estoque_atual = extra.estoque;
                            camadas.metadados = metadados;

                            return { row, camadas };
                        })
                    );

                    if (linhasComCamadas.length > 0) {
                        await client.query('BEGIN');

                        // ── UPSERT em catalogo_ativo (snapshot por produto) ──────────────
                        const ativoPlaceholders = linhasComCamadas.map((_, i) =>
                            `($${i*11+1},$${i*11+2},$${i*11+3},$${i*11+4},$${i*11+5},$${i*11+6},$${i*11+7},$${i*11+8},$${i*11+9},$${i*11+10},$${i*11+11})`
                        ).join(', ');
                        const flatValues = linhasComCamadas.flatMap(({ row, camadas }) => [
                            row[0], row[1], row[2], row[3], row[4], row[5], // loja_id, nome, sku, preco, unidade, fonte
                            camadas.membro_core, camadas.marca, camadas.especificacao, camadas.unidade_medida,
                            camadas.metadados ? JSON.stringify(camadas.metadados) : null,
                        ]);
                        const { rows: upsertedRows } = await client.query<{ id: string; produto_nome: string; produto_sku: string | null }>(
                            `INSERT INTO catalogo_ativo
                                 (loja_id, produto_nome, produto_sku, preco, unidade, fonte_ingestao,
                                  membro_core, marca, especificacao, unidade_medida, metadados)
                             VALUES ${ativoPlaceholders}
                             ON CONFLICT (loja_id, produto_nome) DO UPDATE
                                 SET preco = EXCLUDED.preco,
                                     unidade = EXCLUDED.unidade,
                                     disponivel = true,
                                     fonte_ingestao = EXCLUDED.fonte_ingestao,
                                     membro_core = EXCLUDED.membro_core,
                                     marca = EXCLUDED.marca,
                                     especificacao = EXCLUDED.especificacao,
                                     unidade_medida = EXCLUDED.unidade_medida,
                                     metadados = EXCLUDED.metadados,
                                     atualizado_em = now()
                             RETURNING id, produto_nome, produto_sku`,
                            flatValues
                        );

                        // ── INSERT de auditoria em catalogo_historico ───────────────────
                        // Monta linhas com produto_id ligando ao snapshot acima
                        const idMap = new Map<string, string>();
                        for (const r of upsertedRows) idMap.set((r.produto_sku ?? r.produto_nome).toLowerCase(), r.id);

                        const historicoLinhas = linhasNovas.map(item => [
                            idMap.get((item.row[2] ?? item.row[1]).toLowerCase()) ?? null, // produto_id
                            ...item.row,  // loja_id, nome, sku, preco, unidade, fonte
                        ]);
                        const histPlaceholders = historicoLinhas.map((_, i) =>
                            `($${i*7+1},$${i*7+2},$${i*7+3},$${i*7+4},$${i*7+5},$${i*7+6},$${i*7+7})`
                        ).join(', ');
                        await client.query(
                            `INSERT INTO catalogo_historico
                                 (produto_id, loja_id, produto_nome, produto_sku, preco, unidade, fonte_ingestao)
                             VALUES ${histPlaceholders}`,
                            historicoLinhas.flat()
                        );

                        await client.query('COMMIT');
                    }
                }, CHUNK_TIMEOUT_MS, `chunk ${offset}`);
            }
        } finally {
            client.release();
        }

        // ── Relatório Final ──────────────────────────────────────────────────
        let relatorio = `🎉 *Importação Concluída!*\n`;
        if (inseridos > 0) relatorio += `\n🆕 *${inseridos} produto(s) novo(s)*`;
        if (semAlteracao > 0) relatorio += `\n⏭️ *${semAlteracao} sem alteração (preço igual)*`;
        if (ignorados > 0) relatorio += `\n⚠️ *${ignorados} linha(s) inválida(s) ignorada(s)*`;

        if (atualizados > 0) {
            relatorio += `\n\n🔄 *${atualizados} preço(s) atualizado(s)*\n`;
            relatorio += amostraAtualizados.join('\n');
            if (atualizados > 10) {
                relatorio += `\n...e mais ${atualizados - 10} item(s).`;
            }
        }

        await sendTextMessage(from, relatorio.trim());

        // UX Post-Import: Limpa contextos fantasmas e guia o lojista
        await limparContexto(from);
        setTimeout(async () => {
            await sendInteractiveButtons(from, 'O que deseja fazer agora?', [
                { id: 'menu_principal', title: '🔙 Menu Principal' },
            ]);
        }, 800);

    } catch (err) {
        logger.error({ err, from: masked }, '[DOC] Falha');
        await sendTextMessage(from, '❌ Erro ao processar arquivo. Verifique o conteúdo e tente novamente.');
        await limparContexto(from);
    }
}

