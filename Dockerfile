FROM node:18-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --production || npm install --production

COPY bot.js .

# Install Bullpen CLI
RUN curl -fsSL https://raw.githubusercontent.com/BullpenFi/bullpen-cli-releases/main/install.sh | bash

ENV BULLPEN_BIN=/usr/local/bin/bullpen
ENV BULLPEN_HOME=/root/.bullpen

CMD ["node", "bot.js"]
