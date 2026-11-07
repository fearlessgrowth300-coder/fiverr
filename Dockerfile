FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY app.js ./app.js
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
ENV HOST=0.0.0.0 PORT=8787 DATA_DIR=/app/data
EXPOSE 8787
CMD ["node", "scripts/dev.mjs"]
