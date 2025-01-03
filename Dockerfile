FROM node:18

WORKDIR /app

# Копіюємо package.json і встановлюємо залежності
COPY package.json ./
RUN npm install

# Копіюємо весь проєкт
COPY . .

# Відкриваємо порт
EXPOSE 3000

# Запускаємо бекенд
CMD ["node", "index.js"]
