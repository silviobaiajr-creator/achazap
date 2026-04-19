# AchaZap: Manual Oficial do Sistema e Arquitetura 🛒

> **Nota:** Este é o Documento Vivo (Living Document) que detalha como o AchaZap *pensa*, *opera* e *investiga* seus próprios erros. Ele deve ser atualizado continuamente durante o desenvolvimento.

---

## 1. Visão Geral da Arquitetura
O AchaZap NÃO é um chatbot comum que manda mensagens para uma IA e devolve texto. Ele funciona como uma "Máquina de Estados de Servidor" orientada a Eventos.

**Fluxo Tecnológico:**
1. **Meta (WhatsApp)** → 2. **Webhook (Render)** → 3. **Fila de Processamento (pg-boss/Supabase)** → 4. **Worker/Orchestrator** → 5. **Gemini AI** → 6. **Resposta (WhatsApp)**.

---

## 2. A Máquina de Estados (Contexto)
Toda conversa no AchaZap é baseada no `estado` atual do lojista. O `redis-cloud.ts` (na memória) guarda ONDE o lojista parou.

### Estados Principais:
- `IDLE`: Fluxo livre. Aguardando comando.
- `ONBOARDING_*`: Coletando nome, cidade, bairro e categoria para criar a loja.
- `AGUARDANDO_DADOS_PRODUTO`: Esperando o Lojista mandar texto ou áudio/foto do produto.
- `AGUARDANDO_CONFIRMACAO_ALTERACOES`: IA extraiu dados, mostrou tabela e aguarda clique em ✅ Confirmar.
- `AGUARDANDO_EDICAO_COLUNA`: Lojista clicou que quer editar um campo de um item específico.
- `REVISANDO_PRECOS`: Loop infinito até que todos os "itens com preços antigos" sejam checados pelo Lojista.

---

## 3. As Engrenagens (Módulos Core)

### A. Webhook (`server.ts`)
A porta de entrada. Ele rejeita tudo que não for tipo de mensagem permitida (Texto, Imagem, Voice, Audio, Interativo). Se for Válido, ele **não responde**. Ele simplesmente joga a mensagem na Fila (Queue) e mata a requisição HTTP. 

### B. Worker & Queue (`messageQueue.ts`)
A fila (`pg-boss`) é a infraestrutura mais vital. Se 100 lojistas mandarem fotos juntos, o AchaZap processa 1 por vez de forma ordeira, evitando estourar cotas da Gemini ou derreter a memória do servidor.

### C. O Orquestrador (`orchestrator.ts`)
O "cérebro tático". Ele pega a mensagem da fila, olha o Estado da Sessão, e decide para qual "Skill" jogar a bola.
- Se o lojista enviar `"Quero editar um produto"`, o Orquestrador muda a trava temporal dele.
- Se a Gemini devolver as informações soltas, o Orquestrador monta as listas visuais no padrão do ZAP.

---

## 4. Observabilidade & Auditoria (Masterclass) 🔥

Para que você (Admin) não fique cego caso a IA ou o banco de dados quebrem, o AchaZap implementa três camadas brutas de auditoria.

### Nível 1: Logs de Fluxo (Tabela `logs_dev`)
Essa tabela é a "Caixa Preta do Avião". Tudo o que transita (Eventos do Webhook, CLIQUES DE BOTÃO DO LOJISTA, Envios de Botões, Disparo da Fila) é logado no banco de dados. 
- Ferramenta: O script de emergência `npx tsx scripts/diagnostics.ts` puxa essa tabela, organiza por milissegundo e plota na sua tela uma conversa como um chat puro. Prova absoluta de bugs.

### Nível 2: O Grampo de Erro (`monitor.ts`)
Se uma Query quebrar ou o Gemini der "Internal Server Error", a função `logErroCritico()` ativa o modo pânico:
1. Puxa do Redis em qual `estado` o Lojista acidentado estava.
2. Puxa de histórico as últimas 3 coisas que ele digitou.
3. Empacota tudo em JSON e salva na tabela `logs_erro`.

### Nível 3: Alerta de Dono & Painel Remoto 👑
Sempre que o Nível 2 detecta um erro Fatal, o AchaZap envia um WhatsApp automático para o `ACHAZAP_OWNER_NUMBER` exibindo um painel rico:
- A causa do erro, o número afetado, os 3 últimos textos.
- **Botão Dinâmico "Ver Timeline":** Se clicado por você, faz o Orquestrador rodar uma Query profunda, puxar as mensagens via SQL e enviar a Timeline como texto no seu ZAP.
- **Botão Dinâmico "Mute(1h)":** Se a Meta cair e começar a fludar seu celular, esse botão silencia a Origem (Ex: Webhook) pelo cache Redis por 60 minutos sem desligar o sistema.

---

## 5. Fluxos de Funcionalidade Documentados

### Ingestão Multimodal (Qualquer coisa entra)
O usuário pode mandar uma Foto de Vitrine, um Áudio falando os preços ou um texto longo mal formatado. 
A rota da Ingestão é: 
-> Recebe mídia -> Baixa Mídia em Buffer -> Gemini 1.5 analisa Buffer (Extrai Array de Produtos, Categoriza Novidades vs Ambiguidade) -> Salva em Cache (`AlteracaoPlanejada`) -> Gera visualização "Card" com os itens encontrados para aprovação Humana.

### Revisão de Preços Ativos
O usuário clica em `Revisar Preços`. O banco busca as 10 ofertas mais "velhas".
Ele exibe ao Lojista as mercadorias de uma vez: "Esses batatas tão R$ 10. Algum mudou?".
O Lojista envia as correções num único áudio ou texto, a Gemini mapeia o que subiu, o que não mudou e dá baixa nas 10 de uma vez do lote.

---
*(Desenvolvedores futuros: Sempre que criarem uma Rota Crítica de Sistema, documentem a essência aqui neste arquivo e registrem as lógicas no arquivo CODEBASE caso mexam na estrutura relacional).*
