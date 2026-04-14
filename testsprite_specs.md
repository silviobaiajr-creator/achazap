# 🕵️ Specs de Teste Pro-Max: AchaZap (20 Cenários de Usabilidade)

Este guia contém o mapeamento detalhado de diálogos para a IA do **TestSprite**. Cada cenário simula uma interação real entre o **👤 Lojista** e o **🤖 Bot**.

---

## 🏗️ Guia de Transcrição
*   **👤 Lojista:** Mensagem enviada pelo usuário.
*   **🤖 Bot:** Resposta esperada do sistema (pode variar ligeiramente, mas a intenção e botões devem bater).

---

## 📂 Grupo A: Cadastro e Atualização (Os Essenciais)

### 1. Happy Path: Texto Direto
*   👤 **Lojista:** "Arroz Tio João 5kg R$ 29,90"
*   🤖 **Bot:** "✅ Produto *Arroz Tio João* (5kg) a *R$ 29.90* cadastrado com sucesso!"

### 2. Recuperação: Dado Faltante (Preço)
*   👤 **Lojista:** "Feijão Carioca Kicaldo"
*   🤖 **Bot:** "Faltou o valor! Qual é o preço do *Feijão Carioca Kicaldo*?"
*   👤 **Lojista:** "9.80"
*   🤖 **Bot:** "✅ Produto *Feijão Carioca Kicaldo* (un) a *R$ 9.80* cadastrado com sucesso!"

### 3. Recuperação: Dado Faltante (Unidade)
*   👤 **Lojista:** "Batata Doce 4.50"
*   🤖 **Bot:** "Qual a unidade? (kg, g, un, pacote, cx, lata...)"
*   👤 **Lojista:** "kg"
*   🤖 **Bot:** "✅ Produto *Batata Doce* (kg) a *R$ 4.50* cadastrado com sucesso!"

### 4. Lote por Texto (Multi-Produtos)
*   👤 **Lojista:** "Leite 5.00, Ovos 12.00, Pão 4.50"
*   🤖 **Bot:** "⏳ Verificando *3* produto(s) no estoque... (Exibe resumo)... ⚡ Confirma as alterações acima?"
*   🤖 **Botões:** [✅ Confirmar Todos] [✏️ Editar um Item] [❌ Cancelar Tudo]
*   👤 **Lojista:** (Clica em Confirmar Todos)
*   🤖 **Bot:** "✅ *3* novo(s) cadastrado(s)"

---

## 🧠 Grupo B: Inteligência de Busca e Ambiguidade

### 5. Desempate Manual (Peneira)
*   👤 **Lojista:** "Coca 2L R$ 9,00" (Existem "Coca Zero" e "Coca Normal" no banco)
*   🤖 **Bot:** "🔍 Encontrei produtos parecidos no estoque:\n1 - Coca Cola Zero 2L\n2 - Coca Cola Original 2L\n0 - Nenhum (cadastrar novo)"
*   👤 **Lojista:** "2"
*   🤖 **Bot:** "Selecionado: *Coca Cola Original 2L*. O que deseja fazer?\n[Atualizar R$ 9.00] [Retirar Estoque]"

### 6. Desempate por NLP (Falar em vez de digitar número)
*   👤 **Lojista:** (Bot mostra a lista de Cocas do cenário acima)
*   👤 **Lojista:** "É a segunda opção, a original"
*   🤖 **Bot:** "Selecionado: *Coca Cola Original 2L*..." (IA deve entender "segunda" via NLP)

### 7. Sugestão Ortográfica
*   👤 **Lojista:** "Cveja Heinkn 8,50"
*   🤖 **Bot:** "🤔 Fiquei na dúvida... Você quis dizer *Cerveja Heineken*? [Sim, isso mesmo] [Não, digitar denovo]"
*   👤 **Lojista:** "Sim"
*   🤖 **Bot:** "Ótimo, ajustado! ✅ Produto cadastrado..."

---

## 🖼️ Grupo C: Multimodal (OCR e Áudio)

### 8. Foto de Encarte (OCR)
*   👤 **Lojista:** (Envia foto de uma lista de preços)
*   🤖 **Bot:** "👀 Recebi sua mídia! Me dê uns segundinhos..." -> "📋 Resumo — 5 produto(s) encontrado(s)..."
*   🤖 **Botões:** [✅ Confirmar Todos] [✏️ Editar um Item] [❌ Cancelar Tudo]

### 9. Áudio de Estoque
*   👤 **Lojista:** (Envia áudio: "Cadastra aí picanha 60 reais o quilo")
*   🤖 **Bot:** "👀 Recebi sua mídia!..." -> "✅ Produto *Picanha* (kg) a *R$ 60.00* cadastrado com sucesso!"

### 10. Erro: Foto Embaçada
*   👤 **Lojista:** (Envia foto toda borrada)
*   🤖 **Bot:** "📷 A foto/áudio ficou difícil de ler. Pode mandar novamente com mais nitidez?"

---

## 🛠️ Grupo D: Gestão de Estoque e Edição

### 11. Edição em Lote (Corrigir um item da lista)
*   👤 **Lojista:** (Bot mostra resumo de 3 itens)
*   👤 **Lojista:** (Clica em [✏️ Editar um Item])
*   🤖 **Bot:** "Digite o NÚMERO do item que deseja editar"
*   👤 **Lojista:** "2"
*   🤖 **Bot:** "Você escolheu: *Ovos*. Digite o NOVO PREÇO ou 0 para excluir."
*   👤 **Lojista:** "10.00"
*   🤖 **Bot:** "✅ Preço corrigido! (Mostra resumo atualizado)"

### 12. Exclusão via Edição (Remover da lista)
*   👤 **Lojista:** (No fluxo de edição acima)
*   👤 **Lojista:** "0"
*   🤖 **Bot:** "🗑️ Item removido com sucesso! (Mostra resumo sem o item)"

### 13. Retirada de Estoque (Ledger Soft-Delete)
*   👤 **Lojista:** (No fluxo de desempate/seleção)
*   👤 **Lojista:** (Clica em [Retirar Estoque])
*   🤖 **Bot:** "✅ *Produto X* retirado do estoque e oculto das buscas!"

---

## 🎫 Grupo E: Ofertas e Administração

### 14. Criar Oferta (Happy Path)
*   👤 **Lojista:** (Clica em Menu > Criar Ofertas)
*   👤 **Lojista:** "80 reais, 10%, validade 30/12/2026"
*   🤖 **Bot:** "✅ Oferta criada! *10%* de desconto para compras acima de R$ 80.00. Válido até 2026-12-30."

### 15. Ver Ofertas Ativas
*   👤 **Lojista:** (Menu > Ver Ofertas Ativas)
*   🤖 **Bot:** "📢 Suas ofertas ativas:\n• A partir de R$ 80.00 -> 10% off (até 30/12/2026)"

### 16. Ver Estatísticas
*   👤 **Lojista:** "Menu > Ver Estatísticas"
*   🤖 **Bot:** "📊 Estatísticas da sua loja:\nSaldo de cliques: 500\nStatus: Ativa\nCliques (30 dias): 42"

---

## 🛡️ Grupo F: Resiliência e Exceções

### 17. Fuga Global (Abortar Missão)
*   👤 **Lojista:** (No meio de qualquer pergunta sobre preço)
*   👤 **Lojista:** "para tudo, volta pro menu"
*   🤖 **Bot:** "Sem problemas! Operação cancelada. 🧹 O que gostaria de fazer agora? (Mostra Menu)"

### 18. Ruído/Papo Furado (Fora de fluxo)
*   👤 **Lojista:** "Oi, como tá o tempo hoje?"
*   🤖 **Bot:** "Não sei sobre isso! 😅 Sou treinado apenas para organizar a sua loja. Escolha uma opção: (Envia Menu)"

### 19. Anti-Spam (Rajada de Mensagens)
*   👤 **Lojista:** (Envia 5 mensagens seguidas em 1 segundo)
*   🤖 **Bot:** (Deve processar apenas a primeira ou enfileirar corretamente via Redis Lock, ignorando o spam repetido do menu).

### 20. Cold Start (Waking Up)
*   👤 **Lojista:** "Oi" (Após 1 hora de silêncio)
*   🤖 **Bot:** (Pode demorar uns segundos a mais no Render Free, mas deve responder com o Menu Principal com o nome da Loja correto).
