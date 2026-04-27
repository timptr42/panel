FROM node:22-alpine

RUN apk add --no-cache bash util-linux

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

ENV NODE_ENV=production
ENV PORT=7777

EXPOSE 7777

CMD ["npm", "start"]
