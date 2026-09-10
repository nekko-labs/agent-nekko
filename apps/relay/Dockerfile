# Kotrain relay: tiny, stateless, self-hostable. Build from the REPO ROOT:
#   docker build -f apps/relay/Dockerfile -t kotrain-relay .
# Run:
#   docker run -p 4400:4400 kotrain-relay
# The relay only routes end-to-end-encrypted frames; it holds no data worth
# backing up, so horizontal scaling / restarts are painless (agents reconnect).

FROM node:22-slim AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/relay/package.json apps/relay/package.json
# --include-workspace-root pulls the root devDeps (typescript, @types/node).
RUN npm ci -w @agent-nekko/relay --include-workspace-root
COPY apps/relay apps/relay
RUN npx tsc -p apps/relay/tsconfig.json

FROM node:22-slim AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/relay/package.json apps/relay/package.json
RUN npm ci -w @agent-nekko/relay --omit=dev

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=build /repo/apps/relay/dist ./dist
COPY apps/relay/package.json ./package.json
USER node
EXPOSE 4400
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+(process.env.KOTRAIN_RELAY_PORT||4400)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
