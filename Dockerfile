# --- deps stage: compile native modules (better-sqlite3) ---
FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- runtime stage: lean image, no build toolchain ---
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public

EXPOSE 4000
CMD ["node", "src/index.js"]
