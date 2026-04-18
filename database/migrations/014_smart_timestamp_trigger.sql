-- ============================================================
-- AchaZap — Migration 014: Trigger Inteligente (Manual Override)
--
-- PROBLEMA: O trigger original sempre sobrescrevia atualizado_em com now()
--           em qualquer UPDATE, impedindo testes manuais de datas passadas.
--
-- SOLUÇÃO: O trigger agora só atualiza para agora() se o valor da coluna
--          não tiver sido alterado explicitamente na query de UPDATE.
-- ============================================================

CREATE OR REPLACE FUNCTION fn_set_atualizado_em()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    -- Verifica se o valor de atualizado_em foi mantido o mesmo.
    -- Se sim, a alteração foi em outras colunas (preco, etc) e queremos o timestamp de agora.
    -- Se não, o usuário enviou uma data específica (manual override para teste) e respeitamos.
    IF (NEW.atualizado_em IS NOT DISTINCT FROM OLD.atualizado_em) THEN
        NEW.atualizado_em = now();
    END IF;
    
    RETURN NEW;
END;
$$;

-- O trigger já existe na tabela catalogo_ativo da migration 013,
-- então apenas atualizar a função acima já aplica a nova lógica.
