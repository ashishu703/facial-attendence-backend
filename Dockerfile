# 1. Base image chunein (Node.js 18)
FROM node:18-alpine

# 2. App ke liye ek folder banayein container ke andar
WORKDIR /app

# 3. package.json aur lock file copy karein
COPY package*.json ./

# 4. Dependencies install karein (sirf production waali)
RUN npm install --production

# 5. Baaki saara code copy karein (server.js, backend/ folder, etc.)
COPY . .

# 6. Default command (yeh docker-compose mein override ho jaayegi)
CMD ["node", "server.js"]
