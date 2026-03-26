# AchaZap 🛒

> Assistente de IA via WhatsApp para busca de produtos no varejo de bairro.

## Stack

| Camada | Tecnologia |
|---|---|
| Mensageria | WhatsApp Business API (Meta Cloud) |
| Backend | Node.js + TypeScript |
| IA | Gemini (Function Calling + Multimodal) |
| Banco de Dados | PostgreSQL via Supabase |
| Filas | BullMQ + Redis |

---

## Estrutura do Projeto

```
achazap/
├── database/
│   ├── migrations/
│   │   ├── 001_initial_schema.sql   ← Tabelas principais
│   │   ├── 002_triggers.sql         ← Triggers de saldo_cliques
│   │   └── 003_indexes.sql          ← Índices de performance
│   ├── seeds/
│   │   └── seed_dev.sql             ← Dados de desenvolvimento
│   └── queries_dev.sql              ← Queries utilitárias
├── src/
│   ├── webhook/
│   │   └── webhookController.ts     ← Recebe e valida mensagens WhatsApp
│   ├── processor/
│   │   └── messageProcessor.ts      ← Worker BullMQ + loop Function Calling
│   ├── skills/                      ← Skills da IA (Function Calling)
│   │   ├── buscarOfertas.ts
│   │   ├── analisarHistoricoPreco.ts
│   │   ├── gerarLinkRedirecionamento.ts
│   │   ├── cadastrarAtualizarUsuario.ts
│   │   ├── obterPerfilUsuario.ts
│   │   ├── ingerirCatalogoCSV.ts
│   │   └── ingerirCatalogoMidia.ts
│   ├── routes/
│   │   └── redirect.ts              ← GET /r?token= (débito + redirect wa.me)
│   ├── db/
│   │   └── client.ts                ← Cliente Supabase/PostgreSQL
│   └── index.ts                     ← Entry point
├── .env.example
├── package.json
└── tsconfig.json
```

---

## Setup — Banco de Dados (Supabase)

### 1. Crie um projeto no [Supabase](https://supabase.com)

### 2. Execute as migrations na ordem no SQL Editor:

```sql
-- Cole e execute cada arquivo na sequência:
-- 1. database/migrations/001_initial_schema.sql
-- 2. database/migrations/002_triggers.sql
-- 3. database/migrations/003_indexes.sql
```

### 3. Carregue os dados de desenvolvimento (opcional):

```sql
-- database/seeds/seed_dev.sql
```

### 4. Copie as credenciais para o `.env`:

```env
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
DATABASE_URL=postgresql://postgres:[password]@...
```

---

## Variáveis de Ambiente

```env
# Supabase
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=

# WhatsApp Business API
WHATSAPP_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_VERIFY_TOKEN=       # token secreto para verificação do webhook
WHATSAPP_APP_SECRET=         # usado para validar assinatura HMAC

# Google AI (Gemini)
GEMINI_API_KEY=

# Redis (BullMQ)
REDIS_URL=redis://localhost:6379

# App
PORT=3000
BASE_URL=https://achazap.com  # usado para gerar os links /r?token=
```

---

## Fases de Desenvolvimento

| Fase | Status | Descrição |
|---|---|---|
| F1 — Schema SQL | ✅ Concluída | Tabelas, triggers, índices, seed |
| F2 — Webhook | ⏳ Próxima | Endpoint + validação HMAC + fila |
| F3 — Busca Core | ⏳ Pendente | Skills de busca, link e débito |
| F4 — Onboarding | ⏳ Pendente | Cadastro de usuário + localização |
| F5 — Histórico | ⏳ Pendente | Análise de oferta real 🔥 |
| F6 — Ingestão CSV | ⏳ Pendente | Upload de catálogo |
| F7 — Ingestão Mídia | ⏳ Pendente | Foto/Áudio → Gemini → catálogo |
| F8 — Painel Lojista | ⏳ Pendente | Dashboard web |

---

## Regras de Negócio Críticas

> ⚡ **Clique é debitado ao CLICAR no link `/r?token=`**, nunca ao gerar o link.

> 🗄️ **`catalogo_historico` é append-only**. Nunca fazer UPDATE/DELETE de preços.

> 🔒 **`lojas.saldo_cliques`** é mantido por triggers PostgreSQL. Não alterar via código.

> 🔁 **Deduplicação**: mesmo `usuario+loja+produto` dentro de 1 hora → sem débito.
