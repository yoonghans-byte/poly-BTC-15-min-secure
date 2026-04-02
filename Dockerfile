FROM node:20-alpine

WORKDIR /app

COPY package.json tsconfig.json vitest.config.ts .
COPY src ./src
COPY config.yaml ./config.yaml
COPY .env.example ./.env.example
COPY README.md ./README.md
COPY SETUP_GUIDE.md ./SETUP_GUIDE.md

RUN npm install
RUN npm run build

ENV NODE_ENV=production

CMD ["node", "dist/cli.js", "start", "--config", "config.yaml"]
