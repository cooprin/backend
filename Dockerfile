FROM node:18

ENV NODE_OPTIONS="--max-http-header-size=32768"

WORKDIR /app

# Копіюємо package.json і встановлюємо залежності
COPY package*.json ./
RUN npm install
RUN npm install express jsonwebtoken bcrypt pg winston

# Створюємо структуру директорій
RUN mkdir -p /app/data/uploads /app/data/logs

# Копіюємо всі файли проекту
COPY . .

# Налаштовуємо права
RUN chown -R node:node /app/data

# Переключаємось на користувача node
USER node

# Відкриваємо порт
EXPOSE 3000

# Запускаємо скрипт ініціалізації та сервер
CMD ["sh", "-c", "node scripts/init-dirs.js && node src/index.js"]