# Focus Forest API image (CR.7). Three stages:
#   build    installs everything, generates the Prisma client, and compiles.
#   migrate  runs `prisma migrate deploy` once per release, before the new API starts.
#   runtime  (default) the API alone: production dependencies, compiled code, non-root.
# The host is chosen later; see DEPLOY.md.

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json prisma7.config.ts ./
COPY prisma ./prisma
RUN npm ci
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

FROM build AS migrate
ENV NODE_ENV=production
CMD ["npx", "prisma", "migrate", "deploy"]

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/health" >/dev/null || exit 1
CMD ["node", "dist/main"]
