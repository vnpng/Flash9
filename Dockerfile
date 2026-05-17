FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js Flash9_demo.html ./
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "--max-old-space-size=64", "server.js"]
