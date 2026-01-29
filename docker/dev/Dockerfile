FROM node:20-bullseye

# Build tools for native deps: better-sqlite3 (nexus) and node-pty (worker)
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Build native modules from source to avoid prebuilt/ABI issues inside containers
ENV npm_config_build_from_source=true

# Install dependencies (workspace-aware)
COPY package*.json ./
COPY nexus/package*.json nexus/
COPY worker/package*.json worker/
COPY client/package*.json client/
RUN rm -rf node_modules
RUN npm ci --unsafe-perm --build-from-source

# Ensure key native deps are rebuilt explicitly
RUN npm rebuild better-sqlite3 node-pty --unsafe-perm

# Copy source
COPY . .

ARG SERVICE
ENV SERVICE=${SERVICE}
ENV NODE_ENV=development

EXPOSE 3002

CMD ["sh", "-c", "npm run start --workspace=$SERVICE"]
