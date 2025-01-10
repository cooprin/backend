FROM node:18

WORKDIR /app

# Копіюємо package.json і встановлюємо залежності
COPY package.json ./
RUN npm install
RUN npm install express jsonwebtoken bcrypt pg


# Копіюємо весь проєкт
COPY . .

# Відкриваємо порт
EXPOSE 3000

# Запускаємо бекенд
CMD ["node", "src/index.js"]
