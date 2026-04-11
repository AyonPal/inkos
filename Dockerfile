FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev && npm install prisma tsx typescript --save-dev

COPY prisma ./prisma
RUN npx prisma generate

COPY src ./src
COPY tsconfig.json ./

ENV NODE_ENV=production
ENV PORT=3002
EXPOSE 3002

CMD ["sh", "-c", "npx prisma migrate deploy && node --import tsx src/server.ts"]
