# 🚀 Guia de Deploy: AchaZap (Render + UptimeRobot)

Este guia ensina como colocar o AchaZap online em produção de forma gratuita e estável.

## 1. Preparação (GitHub)
1. Crie um repositório **Privado** no seu GitHub.
2. Suba todos os arquivos do projeto para lá (exceto o `.env` e `node_modules`).
   - *Dica: O arquivo `.gitignore` já deve estar configurado para ignorar esses arquivos.*

## 2. Configuração no Render
1. Acesse [dashboard.render.com](https://dashboard.render.com).
2. Clique em **New +** e escolha **Blueprint**.
3. Conecte sua conta do GitHub e selecione o repositório do `achazap`.
4. O Render lerá o arquivo `render.yaml` automaticamente.
5. **Configurar as Variáveis**: Clique em "Environment" e preencha TODAS as chaves listadas com os valores do seu `.env` local.
   - **IMPORTANTE**: Em `BASE_URL`, coloque a URL que o Render te der (ex: `https://achazap-xyz.onrender.com`).
6. Clique em **Apply**. Aguarde o build terminar (pode levar 3-5 minutos).

## 3. Configuração no UptimeRobot (MANTENDO VIVO)
Como estamos no plano grátis, o app dorme após 15 min. Vamos evitar isso:
1. Acesse [uptimerobot.com](https://uptimerobot.com).
2. Clique em **Add New Monitor**.
3. **Monitor Type**: HTTP(s).
4. **Friendly Name**: AchaZap Health.
5. **URL**: `https://seu-app.onrender.com/health` (substitua pelo seu link real).
6. **Monitoring Interval**: Every 5 minutes.
7. Clique em **Create Monitor**.

## 4. Atualizar o Webhook na Meta
Agora que você tem uma URL fixa e pública:
1. Vá no Painel da Meta (WhatsApp Business API).
2. Vá em **Configurações de Webhook**.
3. Altere a **URL de retorno** (Callback URL) para: `https://seu-app.onrender.com/webhook`.
4. O **Verify Token** deve ser o mesmo que você definiu no ambiente do Render.

---
✅ **Pronto!** Seu bot agora está rodando em um servidor real e o UptimeRobot garantirá que ele responda instantaneamente.
