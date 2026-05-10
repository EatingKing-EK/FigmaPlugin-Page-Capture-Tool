FROM mcr.microsoft.com/playwright:v1.59.1-noble

WORKDIR /app

ENV NODE_ENV=production
ENV PAGE_CAPTURE_HOST=0.0.0.0
ENV PAGE_CAPTURE_PORT=3845
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY service ./service

RUN mkdir -p .capture-artifacts

EXPOSE 3845

CMD ["node", "service/server.mjs"]
