FROM mcr.microsoft.com/playwright:v1.63.0-noble
ENV NODE_ENV=production TZ=Asia/Shanghai
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY index.js challenge.js entrypoint.sh ./
RUN chmod +x /app/entrypoint.sh && mkdir -p /app/data /tmp/.X11-unix \
    && chmod 1777 /tmp/.X11-unix && chown -R pwuser:pwuser /app
USER pwuser
ENTRYPOINT ["/app/entrypoint.sh"]
