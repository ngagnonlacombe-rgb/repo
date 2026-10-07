FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production DOSSIER_DONNEES=/donnees PORT=3000
VOLUME /donnees
EXPOSE 3000
CMD ["node", "--no-warnings", "server.js"]
