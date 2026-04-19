# Manual do Produto: AchaZap 🛒

Este é o **Manual Oficial de Uso** do AchaZap. Ele descreve as funcionalidades do ponto de vista do **Lojista** e das **Regras de Negócio**, servindo como o guia definitivo de "O que o sistema faz e como usar".

Ele é atualizado paralelamente a cada nova funcionalidade adicionada ao sistema.

---

## 1. O que é o AchaZap?
O AchaZap é um assistente de inteligência artificial via WhatsApp focado em **Lojistas de Bairro**. O objetivo é permitir que mercadinhos e farmácias digitalizem seus estoques sem nenhum jargão técnico, apenas conversando, enviando áudios ou tirando fotos das prateleiras. Em troca, essas ofertas são conectadas aos consumidores locais.

---

## 2. Onboarding (Primeiro Acesso)
Quando um Lojista envia a primeira mensagem para o número do AchaZap, o sistema reconhece que o número é inédito na base e entra no "Modo Onboarding".

**Como funciona:**
1. O robô pergunta o **Nome da Loja**.
2. A **Localização** (Cidade e Bairro).
3. A **Categoria** da loja (mostrando um menu interativo com opções como Supermercado, Farmácia, Padaria, etc).
4. Ao concluir, o lojista ganha um **Saldo de Cliques Gratuito** (ex: 100 cliques) para iniciar as vendas.

---

## 3. Gestão de Catálogo (Ingestão Multimodal)

A funcionalidade mais poderosa do AchaZap. O lojista clica no menu "Gestão de Estoque" -> "Cadastrar/Atualizar", e o robô fica "de ouvidos abertos". 

**O Lojista pode enviar os produtos de três formas:**
- 📝 **Texto Simples:** "Batata ta 5 reais, cebola 3 e a coca cola de lata é 4,50"
- 🎤 **Áudio (Voz):** O lojista manda um áudio natural ditando os preços da prateleira.
- 📷 **Foto:** O lojista manda uma foto da vitrine ou de uma lista escrita em um papel.

**O que o Sistema (IA) Faz:**
1. Lê qualquer um desses formatos e extrai o Nome do Produto e o Preço exato.
2. Compara com o que já existe no estoque do lojista (banco de dados).
3. Devolve uma tabela de resumo clara: *"Encontrei 3 produtos. 2 novos, 1 preço atualizado."*
4. O lojista usa os botões para aprovar ou pede para editar caso algum tenha ficado ambíguo.

---

## 4. Revisão de Preços Ativos
O sistema combate preços mortos no estoque. No Menu Principal, a opção **"Revisar Preços"** puxa até 10 produtos que estão há mais tempo sem atualização no banco de dados.

**O Fluxo:**
1. O robô envia de uma vez a lista dos 10 itens mais "velhos".
   *Ex: "A Arroz Tio João ainda é R$ 25,00?"*
2. Em vez de perguntar um por um de forma chata, o lojista manda uma única resposta: *"O arroz subiu pra 27 e a feijão pra 10, o resto ta igual"*.
3. O robô usa a IA para bater as mudanças e atualiza a *data de validade (freshness)* de toda a lista num único movimento, poupando extremo esforço do humano.

---

## 5. Regras Financeiras e Cliques
O sistema não cobra mensalidade. Ele cobra apenas por "Desempenho Real" através de saldo de cliques no modelo pré-pago.

- Toda vez que um consumidor (comprador final) encontra uma oferta e clica para ir falar com o lojista (`/r?token=`), **1 clique é descontado** do saldo da loja.
- **Camada de Proteção:** Se a mesma loja for clicada de novo dentro da mesma janela curta de tempo pelo mesmo processo, o sistema "Deduplica" e evita cobrar dois cliques injustamente.
- O Lojista pode consultar o próprio extrato no Menu *"Estatísticas"*.

---

*(Este documento deve ser acrescido de novos parágrafos sempre que construirmos frentes como: "Geração de Ofertas Especiais", "Modelos de Recorrência para Compradores" ou "Dashboard Web").*
