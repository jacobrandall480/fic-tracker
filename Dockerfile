# ---- Build stage ----
# Installs dependencies and builds the Vite/React app into static files (dist/).
FROM node:20-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

# ---- Runtime stage ----
# Wrangler (Cloudflare's CLI) emulates Pages + Pages Functions locally — the
# same routing/runtime that serves this app in production on Cloudflare's edge.
FROM node:20-alpine AS runtime
WORKDIR /app

RUN npm install -g wrangler

# Only copy what's needed to serve the app: the built static site, and the
# Pages Functions directory (Wrangler auto-detects it as a sibling of dist/).
COPY --from=build /app/dist ./dist
COPY --from=build /app/functions ./functions

EXPOSE 8788

# --ip 0.0.0.0 is required so the server is reachable from outside the container.
CMD ["wrangler", "pages", "dev", "dist", "--ip", "0.0.0.0", "--port", "8788", "--compatibility-date=2026-06-29"]
