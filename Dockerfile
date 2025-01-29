FROM node:18

WORKDIR /app

# Копіюємо package.json і встановлюємо залежності
COPY package*.json ./
RUN npm install
RUN npm install express jsonwebtoken bcrypt pg

# Копіюємо всі файли проекту
COPY . .

# Створюємо базові директорії
RUN mkdir -p /app/data/uploads /app/data/logs

# Налаштовуємо права
RUN chmod +x /app/scripts/init-dirs.js

# Відкриваємо порт
EXPOSE 3000

# Запускаємо скрипт ініціалізації та сервер
CMD ["sh", "-c", "node scripts/init-dirs.js && node src/index.js"]