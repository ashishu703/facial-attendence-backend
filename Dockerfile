# 1. Base image chunein (Node.js 18)
FROM node:18-alpine

# 2. App ke liye ek folder banayein container ke andar
WORKDIR /app

# 3. [FIX] 'canvas' package ke liye zaroori build tools aur libraries install karein
# Yeh node-gyp build errors ko solve karega
RUN apk add --no-cache python3 build-base cairo-dev jpeg-dev pango-dev giflib-dev

# 4. package.json aur lock file copy karein
COPY package*.json ./

# 5. Dependencies install karein (sirf production waali)
RUN npm install --production

# 6. Baaki saara code copy karein (server.js, backend/ folder, etc.)
COPY . .

# 7. Default command (yeh docker-compose mein override ho jaayegi)
CMD ["node", "server.js"]
