# Etapa 1: Build
FROM node:22-slim AS builder

WORKDIR /app

# Copiar arquivos de dependências
COPY package*.json ./
RUN npm install

# Copiar código fonte e tsconfig
COPY . .

# Build do TypeScript
RUN npm run build

# Etapa 2: Produção
FROM node:22-slim

WORKDIR /app

# Variável de ambiente para produção
ENV NODE_ENV=production

# Copiar apenas o necessário da etapa anterior
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules

# Expõe a porta padrão do Render
EXPOSE 3000

# Comando para iniciar o servidor
CMD ["npm", "start"]
