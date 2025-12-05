# Use the official Node.js Debian image as the base image
FROM node:22-bookworm-slim AS base

# Configurações essenciais do Puppeteer
ENV CHROME_BIN="/usr/bin/chromium" \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD="true" \
    PUPPETEER_EXECUTABLE_PATH="/usr/bin/chromium" \
    NODE_ENV="production"

WORKDIR /usr/src/app

# --- Estágio de Dependências ---
FROM base AS deps

COPY package*.json ./

# Removemos o --ignore-scripts para garantir que libs nativas compilem se necessário
RUN npm ci --include=dev

# --- Estágio Final ---
FROM base

# 1. Instalação robusta (Chromium + Fontes + Init System)
# dumb-init: Evita "processos zumbis" do Chrome que comem memória
# fonts-*: WhatsApp Web usa fontes específicas, se faltar, ele trava o canvas
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    chromium \
    ffmpeg \
    dumb-init \
    fonts-freefont-ttf \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-symbol-extra \
    fonts-noto-color-emoji \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# 2. Criação explicita da pasta de sessões com permissão
# Isso evita aquele erro de "ENOENT: no such file or directory"
RUN mkdir -p sessions && chmod 777 sessions

# Copia dependências
COPY --from=deps /usr/src/app/node_modules ./node_modules

# Copia o código da aplicação
COPY . .

EXPOSE 3000

# Usa o dumb-init para gerenciar o processo do Node
ENTRYPOINT ["/usr/bin/dumb-init", "--"]

CMD ["npm", "start"]