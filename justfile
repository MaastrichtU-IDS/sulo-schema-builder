# Task runner for sulo-schema-builder, mirroring RDFCraft's justfile
# convention: a plain `docker compose up` server path, and per-OS desktop
# packaging recipes (built once per target OS, not cross-compiled).

# Install all workspace dependencies (api, frontend).
install:
    cd api && npm install
    cd frontend && npm install

# Run the full stack via Docker (single container: API + built SPA).
up:
    docker compose up -d --build

down:
    docker compose down

logs:
    docker compose logs -f api

# Package a standalone desktop binary for the current platform.
package:
    node api/scripts/package-desktop.mjs

# The three recipes below run ON their target OS — this repo doesn't
# cross-compile the desktop bundle, same as RDFCraft's own per-OS recipes.

# Desktop app for the current Mac (Intel or Apple Silicon).
package-mac:
    node api/scripts/package-desktop.mjs
    cp api/pkg-dist/sulo-schema-builder-api desktop/src-tauri/binaries/sulo-schema-builder-api-{{ arch() }}-apple-darwin
    cd desktop && cargo tauri build

# Desktop app for Linux x64. Run this on a Linux machine.
package-linux:
    node api/scripts/package-desktop.mjs node22-linux-x64
    cp api/pkg-dist/sulo-schema-builder-api desktop/src-tauri/binaries/sulo-schema-builder-api-x86_64-unknown-linux-gnu
    cd desktop && cargo tauri build

# Desktop app for Windows x64. Run this on a Windows machine.
package-win:
    node api/scripts/package-desktop.mjs node22-win-x64
    cp api/pkg-dist/sulo-schema-builder-api.exe desktop/src-tauri/binaries/sulo-schema-builder-api-x86_64-pc-windows-msvc.exe
    cd desktop && cargo tauri build
