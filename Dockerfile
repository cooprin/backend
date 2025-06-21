FROM node:18

# Аргумент для типу збірки
ARG BUILD_MODE=production

ENV NODE_OPTIONS="--max-http-header-size=32768"

WORKDIR /app

# Встановлюємо Chrome і залежності
RUN apt-get update && apt-get install -y \
    chromium \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Налаштовуємо змінні для Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Копіюємо package.json і встановлюємо залежності
COPY package*.json ./

# Умовне встановлення залежностей
RUN if [ "$BUILD_MODE" = "production" ] ; then \
        echo "Installing production dependencies..." && \
        npm install --only=production ; \
    else \
        echo "Installing all dependencies including dev..." && \
        npm install ; \
    fi

# Встановлюємо додаткові залежності
RUN npm install express jsonwebtoken bcrypt pg winston

# Для development - встановлюємо nodemon
RUN if [ "$BUILD_MODE" = "development" ] ; then \
        npm install -g nodemon ; \
    fi

# Створюємо структуру директорій
RUN mkdir -p /app/data/uploads /app/data/logs

# Копіюємо всі файли проекту
COPY . .

# Створюємо стартовий скрипт залежно від BUILD_MODE
RUN if [ "$BUILD_MODE" = "production" ] ; then \
        echo '#!/bin/sh' > /app/start.sh && \
        echo 'echo "Starting production server..."' >> /app/start.sh && \
        echo 'node scripts/init-dirs.js && node src/index.js' >> /app/start.sh ; \
    else \
        echo '#!/bin/sh' > /app/start.sh && \
        echo 'echo "Starting development server with nodemon..."' >> /app/start.sh && \
        echo 'node scripts/init-dirs.js && nodemon src/index.js' >> /app/start.sh ; \
    fi

# Робимо скрипт виконуваним
RUN chmod +x /app/start.sh

# Налаштовуємо права
RUN chown -R node:node /app/data

# Переключаємось на користувача node
USER node

# Відкриваємо порт
EXPOSE 3000

# Запускаємо стартовий скрипт
CMD ["/app/start.sh"]