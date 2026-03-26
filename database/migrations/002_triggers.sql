-- =============================================================
-- AchaZap — Migration 002: Triggers & Functions
-- =============================================================
-- Mantém lojas.saldo_cliques automaticamente e de forma atômica.
-- Garante consistência sem cálculos manuais no código da aplicação.

-- =============================================================
-- TRIGGER 1: Incrementa saldo ao comprar pacote
-- =============================================================
CREATE OR REPLACE FUNCTION fn_incrementa_saldo_cliques()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE lojas
  SET    saldo_cliques = saldo_cliques + NEW.quantidade,
         atualizado_em = now()
  WHERE  id = NEW.loja_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_incrementa_saldo ON pacotes_cliques;
CREATE TRIGGER trg_incrementa_saldo
  AFTER INSERT ON pacotes_cliques
  FOR EACH ROW
  EXECUTE FUNCTION fn_incrementa_saldo_cliques();

COMMENT ON FUNCTION fn_incrementa_saldo_cliques IS
  'Chamado após INSERT em pacotes_cliques. Incrementa lojas.saldo_cliques.';

-- =============================================================
-- TRIGGER 2: Decrementa saldo ao EFETIVAR um clique (debitado false → true)
-- IMPORTANTE: o insert em cliques_consumidos é criado com debitado=false pela IA.
-- O débito efetivo ocorre quando o servidor faz UPDATE SET debitado=true ao clicar.
-- =============================================================
CREATE OR REPLACE FUNCTION fn_decrementa_saldo_cliques()
RETURNS TRIGGER AS $$
BEGIN
  -- Só processa quando debitado muda de false para true
  IF (OLD.debitado = false AND NEW.debitado = true) THEN
    -- Protege contra saldo negativo
    IF (SELECT saldo_cliques FROM lojas WHERE id = NEW.loja_id) <= 0 THEN
      RAISE EXCEPTION 'saldo_zerado: loja % sem cliques disponíveis', NEW.loja_id;
    END IF;

    UPDATE lojas
    SET    saldo_cliques = saldo_cliques - 1,
           atualizado_em = now()
    WHERE  id = NEW.loja_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_decrementa_saldo ON cliques_consumidos;
CREATE TRIGGER trg_decrementa_saldo
  AFTER UPDATE ON cliques_consumidos
  FOR EACH ROW
  EXECUTE FUNCTION fn_decrementa_saldo_cliques();

COMMENT ON FUNCTION fn_decrementa_saldo_cliques IS
  'Chamado após UPDATE em cliques_consumidos quando debitado muda false→true. Decrementa lojas.saldo_cliques.';

-- =============================================================
-- TRIGGER 3: Atualiza atualizado_em em lojas e usuarios
-- =============================================================
CREATE OR REPLACE FUNCTION fn_set_atualizado_em()
RETURNS TRIGGER AS $$
BEGIN
  NEW.atualizado_em = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_lojas_atualizado_em ON lojas;
CREATE TRIGGER trg_lojas_atualizado_em
  BEFORE UPDATE ON lojas
  FOR EACH ROW
  EXECUTE FUNCTION fn_set_atualizado_em();

DROP TRIGGER IF EXISTS trg_usuarios_atualizado_em ON usuarios;
CREATE TRIGGER trg_usuarios_atualizado_em
  BEFORE UPDATE ON usuarios
  FOR EACH ROW
  EXECUTE FUNCTION fn_set_atualizado_em();
