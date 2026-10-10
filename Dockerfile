FROM node:22-slim
WORKDIR /app
COPY package*.json .npmrc ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
