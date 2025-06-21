# Multi-stage Dockerfile для Backend

# =============================================================================
# STAGE 1: Base stage (спільна база)
# =============================================================================
FROM node:18-alpine AS base

WORKDIR /app

# Встановлюємо системні залежності
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont

# Налаштовуємо Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_OPTIONS="--max-http-header-size=32768"

# Копіюємо package файли
COPY package*.json ./

# =============================================================================
# STAGE 2: Dependencies stage (встановлення залежностей)
# =============================================================================
FROM base AS dependencies

# Встановлюємо всі залежності (використовуємо npm install замість npm ci)
RUN npm install --production

# =============================================================================
# STAGE 3: Production stage (мінімальний образ)
# =============================================================================
FROM node:18-alpine AS production

WORKDIR /app

# Встановлюємо тільки runtime залежності
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont

# Налаштовуємо Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_OPTIONS="--max-http-header-size=32768"

# Копіюємо тільки production залежності
COPY --from=dependencies /app/node_modules ./node_modules

# Копіюємо тільки необхідні файли додатка
COPY src/ ./src/
COPY scripts/ ./scripts/
COPY package*.json ./

# Створюємо користувача для безпеки
RUN addgroup -g 1001 -S nodejs \
    && adduser -S nodeuser -u 1001

# Створюємо директорії з правильними правами
RUN mkdir -p /app/data/uploads /app/data/logs \
    && chown -R nodeuser:nodejs /app/data \
    && chown -R nodeuser:nodejs /app

# Переключаємось на безпечного користувача
USER nodeuser

# Відкриваємо порт
EXPOSE 3000

# Запускаємо production сервер
CMD ["sh", "-c", "node scripts/init-dirs.js && node src/index.js"]

# =============================================================================
# STAGE 4: Development stage (повний код + dev tools)
# =============================================================================
FROM base AS development

# Встановлюємо всі залежності (використовуємо npm install замість npm ci)
RUN npm install

# Встановлюємо nodemon глобально
RUN npm install -g nodemon

# Копіюємо весь код проекту
COPY . .

# Створюємо директорії
RUN mkdir -p /app/data/uploads /app/data/logs

# Створюємо користувача
RUN addgroup -g 1001 -S nodejs \
    && adduser -S nodeuser -u 1001

# Налаштовуємо права
RUN chown -R nodeuser:nodejs /app/data \
    && chown -R nodeuser:nodejs /app

# Переключаємось на користувача
USER nodeuser

# Відкриваємо порт
EXPOSE 3000

# Запускаємо development сервер з nodemon
CMD ["sh", "-c", "node scripts/init-dirs.js && nodemon src/index.js"]