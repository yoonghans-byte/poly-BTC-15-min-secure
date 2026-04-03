FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json tsconfig.json vitest.config.ts .
COPY src ./src
COPY config.yaml ./config.yaml
COPY .env.example ./.env.example
COPY README.md ./README.md
COPY SETUP_GUIDE.md ./SETUP_GUIDE.md

# Use npm ci for reproducible installs; --omit=dev reduces attack surface (L-8)
RUN npm ci --omit=dev

# Build in a separate step so build tools are not in the final layer
RUN npm install --include=dev && npm run build && npm prune --omit=dev

ENV NODE_ENV=production

# Run as non-root user for least-privilege (L-8)
USER node

CMD ["node", "dist/cli.js", "start", "--config", "config.yaml"]
