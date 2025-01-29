FROM node:18

# Створюємо користувача для додатку
RUN groupadd -r appuser && useradd -r -g appuser appuser

WORKDIR /app

# Копіюємо package.json і встановлюємо залежності
COPY package*.json ./
RUN npm install
RUN npm install winston express jsonwebtoken bcrypt pg multer

# Копіюємо весь проєкт
COPY . .

# Створюємо необхідні директорії
RUN mkdir -p /app/data/uploads/avatars \
    && mkdir -p /app/data/uploads/documents \
    && mkdir -p /app/data/logs/access \
    && mkdir -p /app/data/logs/error \
    && mkdir -p /app/data/logs/audit

# Встановлюємо права доступу
RUN chown -R appuser:appuser /app

# Перемикаємося на користувача без прав root
USER appuser

# Відкриваємо порт
EXPOSE 3000

# Запускаємо скрипт ініціалізації та сервер
CMD ["sh", "-c", "node scripts/init-dirs.js && node src/index.js"]