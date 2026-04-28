FROM node:22-alpine

ARG PANEL_VERSION=dev
ARG PANEL_BUILD=local
ARG BUILD_ID=${PANEL_BUILD}

RUN apk add --no-cache bash util-linux

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

ENV NODE_ENV=production
ENV PORT=7777
ENV PANEL_VERSION=${PANEL_VERSION}
ENV PANEL_BUILD=${BUILD_ID}

EXPOSE 7777

CMD ["npm", "start"]
