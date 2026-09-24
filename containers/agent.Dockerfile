FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl gh ripgrep fd-find \
    && rm -rf /var/lib/apt/lists/*
# Keep both tools at the exact versions consumed by Atrium's package-lock.json.
RUN npm install -g @earendil-works/pi-coding-agent@0.85.1 \
    'github:liu-zhengdong/pi-atrium#43a569353feabcc1105498ae5246410a92d0c9a0' \
    && npm cache clean --force
USER node
WORKDIR /workspace
