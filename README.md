# AchaZap 🛒

> O assistente de IA infalível para o varejo de bairro brasileiro.

---

## 📚 Hub de Documentação (ESSENCIAL)

Se você é o desenvolvedor ou a IA responsável por este projeto, **LEIA ESTES ARQUIVOS PRIMEIRO**:

- **[MANUAL_DO_PRODUTO.md](file:///c:/Users/laris/.gemini/antigravity/scratch/achazap/MANUAL_DO_PRODUTO.md)**: Regras de negócio, fluxos de UX e as "16 Armadilhas" de resiliência.
- **[ARCHITECTURE.md](file:///c:/Users/laris/.gemini/antigravity/scratch/achazap/ARCHITECTURE.md)**: Desenho técnico, DNA de Observabilidade e Esquema de Dados.

---

## Stack

| Camada | Tecnologia |
|---|---|
| **Mensageria** | WhatsApp Business API (Meta Cloud) |
| **IA** | Gemini 1.5 Pro/Flash (Orchestration & Extraction) |
| **Observabilidade** | Alertas Rich WhatsApp + Remote Diagnostics |
| **Banco de Dados** | PostgreSQL (Supabase) + pg_trgm (Fuzzy Search) |
| **Memória/Fila** | Redis (Cloud) |
| **Backend** | Node.js + TypeScript |

---

## Estrutura do Projeto

```
achazap/
├── .agent/                  ← Configurações e Skills da IA Antigravity
├── database/                ← Migrations SQL e Seeds
├── src/
│   ├── ai/
│   │   ├── orchestrator.ts  ← Cérebro do bot (Gerenciamento de Estados)
│   │   ├── schemas.ts       ← Validação rigorosa via Zod
│   │   └── types.ts         ← Máquina de estados finitos
│   ├── skills/              ← Ferramentas que a IA pode invocar
│   ├── lib/                 ← Clientes (WhatsApp, Supabase, Redis, Audit)
│   ├── server.ts            ← Ponto de entrada e Webhook
│   └── routes/              ← Redirecionamento e Débito de Cliques
├── ARCHITECTURE.md          ← Documentação técnica profunda
└── MANUAL_DO_PRODUTO.md     ← Regras de experiência e negócio
```

---

## Setup & Variáveis de Ambiente

### Principais Credenciais (.env)

```env
# Dono do Sistema (Recebe alertas e faz diagnósticos)
ACHAZAP_OWNER_NUMBER=55...

# IA
GEMINI_MODEL=gemini-1.5-pro-latest

# WhatsApp API
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_VERIFY_TOKEN=

# Infra
SUPABASE_URL=
SUPABASE_SECRET_KEY=
REDIS_URL=
```

---

## Fases de Desenvolvimento

| Fase | Status | Descrição |
|---|---|---|
| F1 — Schema SQL | ✅ | Tabelas, triggers e histórico append-only. |
| F2 — Webhook | ✅ | Validação, idempotência (wamid) e logging. |
| F3 — Busca Core | ✅ | Pesquisa léxica (trgm) + Lupa Semântica (LLM). |
| F4 — Onboarding | ✅ | Captura de perfil do lojista automatizada. |
| F5 — Histórico | ✅ | Auditoria de preços e selo de frescor. |
| F6 — Ingestão | ✅ | Multi-produto (Texto, Foto, Áudio, CSV). |
| F7 — Observabilidade| ✅ | DNA de Autodiagnóstico e alertas remotos. |
| F8 — Hardening | ✅ | Blindagem contra as 16 Armadilhas (Em curso). |
| F9 — Modo Consumidor| ✅ | Busca Blindada, Revenue-Locking via botão iterativo. |
| F10 — Hub Analítico | ✅ | Worker para insights de cross-selling de preço. |

---

## Regras de Ouro (DNA do Projeto)

1. **Observabilidade Ativa**: O sistema deve enviar alertas ricos ao dono com botões de ação (`Ver Timeline`, `Mute`) em caso de erro crítico.
2. **Resiliência do Lojista**: Reagir imediatamente (`sendReaction`) com 🔍 para bater o tempo de ansiedade do WhatsApp.
3. **Integridade de Dados**: Nunca gravar dados crus. Sanitizar vírgulas (ex: `10,50` -> `10.50`) e aplicar `substring(0, 250)` preventivo.
4. **Deduplicação de Cliques**: Triggers em SQL garantem que o saldo do lojista só seja debitado se o usuário for único na última hora.
5. **Histórico Sagrado**: Jamais deletar ou alterar um preço antigo. Registre o novo no `catalogo_historico` com o novo timestamp.

