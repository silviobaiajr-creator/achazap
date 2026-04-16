// Script de migração: adiciona coluna updated_at na tabela catalogo_ativo
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!
);

async function runMigration() {
    console.log('🔄 Iniciando migration: ADD COLUMN updated_at...');
    console.log(`📡 Banco: ${process.env.SUPABASE_URL}`);

    // Passo 1: Verifica estrutura atual
    const { data: sample, error: sampleErr } = await supabase
        .from('catalogo_ativo')
        .select('id, produto_nome')
        .limit(1);

    if (sampleErr) {
        console.error('❌ Erro ao acessar catalogo_ativo:', sampleErr.message);
        process.exit(1);
    }

    console.log(`✅ Acesso confirmado — ${sample?.length ?? 0} registro(s) verificado(s)`);

    // Passo 2: Tenta atualizar um registro para checar se updated_at já existe
    console.log('🔍 Verificando se coluna updated_at já existe...');
    const { error: checkErr } = await supabase
        .from('catalogo_ativo')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', '00000000-0000-0000-0000-000000000000'); // ID que não existe — só testa a coluna

    if (!checkErr || checkErr.code === 'PGRST116') {
        console.log('✅ Coluna updated_at já existe no banco!');
        await populateNulls();
        return;
    }

    if (checkErr.code === 'PGRST204') {
        console.log('⚠️ Coluna updated_at NÃO existe. Criando via RPC...');
        
        // Passo 3: Criar coluna via SQL direto
        const { error: rpcErr } = await supabase.rpc('exec_migration_updated_at');

        if (rpcErr) {
            console.error('❌ RPC não disponível:', rpcErr.message);
            console.log('\n📋 Execute manualmente no Supabase SQL Editor:\n');
            console.log('ALTER TABLE catalogo_ativo ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;');
            console.log('UPDATE catalogo_ativo SET updated_at = NOW() WHERE updated_at IS NULL;');
            process.exit(1);
        }

        await populateNulls();
        return;
    }

    console.log('ℹ️ Resposta do banco:', checkErr.code, checkErr.message);
    await populateNulls();
}

async function populateNulls() {
    console.log('\n🔄 Populando registros com updated_at = NULL...');

    // Busca todos os registros sem data
    const { data: semData, error: fetchErr } = await supabase
        .from('catalogo_ativo')
        .select('id')
        .is('updated_at', null)
        .limit(500);

    if (fetchErr) {
        if (fetchErr.code === 'PGRST204') {
            console.log('❌ A coluna ainda não existe no banco.');
            console.log('\n📋 Execute manualmente no Supabase SQL Editor:');
            console.log('ALTER TABLE catalogo_ativo ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;');
            console.log('UPDATE catalogo_ativo SET updated_at = NOW() WHERE updated_at IS NULL;');
            return;
        }
        console.error('❌ Erro ao buscar registros:', fetchErr.message);
        return;
    }

    if (!semData || semData.length === 0) {
        console.log('✅ Todos os registros já têm updated_at preenchido!');
        return;
    }

    console.log(`📝 Atualizando ${semData.length} registro(s) com data atual...`);

    const ids = semData.map(r => r.id);
    const { error: updateErr } = await supabase
        .from('catalogo_ativo')
        .update({ updated_at: new Date().toISOString() })
        .in('id', ids);

    if (updateErr) {
        console.error('❌ Erro ao atualizar:', updateErr.message);
    } else {
        console.log(`✅ ${ids.length} registro(s) atualizados com sucesso!`);
    }
}

runMigration()
    .then(() => {
        console.log('\n🎉 Migration concluída!');
        process.exit(0);
    })
    .catch(err => {
        console.error('💥 Erro fatal:', err);
        process.exit(1);
    });
