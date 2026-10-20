ARG ASSISTANT_BASE_IMAGE=node:24-bookworm-slim
FROM rust:1.98.0-slim-bookworm AS fframes-toolchain
RUN cargo install --locked --version 1.2.0 cargo-fframes --root /opt/fframes && mv /opt/fframes/bin/cargo-fframes /opt/fframes/bin/cargo-fframes.real && cp -a "$(rustc --print sysroot)" /opt/fframes/rust

FROM ${ASSISTANT_BASE_IMAGE} AS fframes-runtime
RUN apt-get update && apt-get install -y --no-install-recommends build-essential pkg-config ffmpeg yasm nasm libx264-dev libx265-dev libopus-dev libclang-dev clang ninja-build libvpx-dev libasound2-dev time && rm -rf /var/lib/apt/lists/*
COPY --from=fframes-toolchain /opt/fframes /opt/fframes
COPY --chmod=0755 scripts/cargo-fframes.py /opt/fframes/bin/cargo-fframes
COPY scripts/fframes-benchmark.py scripts/shared-skills-smoke.js /app/scripts/
COPY examples/fframes-benchmark.rs /app/examples/fframes-benchmark.rs
COPY src/shared-skills.js /app/src/shared-skills.js
ENV PATH=/opt/fframes/bin:/opt/fframes/rust/bin:$PATH TAR_OPTIONS=--no-same-owner FFMPEG_FORCE_BUILD=1

FROM fframes-runtime AS assistant
COPY --from=ghcr.io/astral-sh/uv:0.12.21 /uv /uvx /usr/local/bin/
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv python3-dev build-essential pkg-config ffmpeg espeak-ng poppler-utils tesseract-ocr tesseract-ocr-eng tesseract-ocr-spa tesseract-ocr-rus git ca-certificates curl chromium fonts-liberation fonts-noto-color-emoji ripgrep jq zip unzip procps pandoc libreoffice-writer libreoffice-calc libreoffice-impress && rm -rf /var/lib/apt/lists/*
COPY requirements-tools.txt /opt/requirements-tools.txt
RUN uv pip install --python /usr/bin/python3 --break-system-packages --no-cache -r /opt/requirements-tools.txt
RUN uv venv --python /usr/bin/python3 /opt/speech && uv pip install --python /opt/speech/bin/python --no-cache faster-whisper==1.2.1
WORKDIR /app
COPY scripts/install-tdl.sh /tmp/install-tdl.sh
RUN sh /tmp/install-tdl.sh && rm /tmp/install-tdl.sh
COPY scripts/tdl-user.py /usr/local/bin/tdl
RUN chmod 0755 /usr/local/bin/tdl
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
COPY scripts ./scripts
COPY templates ./templates
ENV NODE_ENV=production WORKSPACE_DIR=/workspace CODEX_HOME=/data/codex HOME=/workspace/state/home PYTHON_BIN=/opt/speech/bin/python WORKSPACE_PYTHON_BASE=/usr/bin/python3 UV_CACHE_DIR=/workspace/state/uv-cache UV_PYTHON_INSTALL_DIR=/workspace/state/uv-python UV_TOOL_DIR=/workspace/state/uv-tools UV_TOOL_BIN_DIR=/workspace/state/home/.local/bin UV_LINK_MODE=copy
RUN mkdir -p /workspace /data/codex
CMD ["node", "src/main.js"]
