# Use the official Node.js Debian image as the base image
FROM node:22-bookworm-slim AS base

ENV CHROME_BIN="/usr/bin/chromium" \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD="true" \
    NODE_ENV="production"

WORKDIR /usr/src/app

FROM base AS deps

COPY package*.json ./

RUN npm ci --only=production --ignore-scripts

# Create the final stage
FROM base

# Install system dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    fonts-freefont-ttf \
    chromium \
    ffmpeg && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Copy only production dependencies from deps stage
COPY --from=deps /usr/src/app/node_modules ./node_modules

# Copy application code
COPY . .

EXPOSE 3000

# Copy and prepare entrypoint
COPY entrypoint.sh /usr/src/app/entrypoint.sh
RUN chmod +x /usr/src/app/entrypoint.sh

# Run the entrypoint script
ENTRYPOINT ["/usr/src/app/entrypoint.sh"]
