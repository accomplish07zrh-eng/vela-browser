# Vela Browser

Vela Browser is an open-source, local-first browser profile manager and anti-detect browser.

This repository is a clean fork of [AliasMode](https://github.com/aliasmode/aliasmode), rebranded as **Vela Browser**. It keeps the upstream local profile-management, proxy, fingerprint, automation API, MCP, scheduling, and multi-window features, while removing upstream brand promotions, affiliate placements, and sponsored service listings from the desktop UI.

## Upstream and licensing

- Upstream project: https://github.com/aliasmode/aliasmode
- Upstream application license: Apache License 2.0
- AliasMode Firefox engine: MPL-2.0
- AliasMode Chromium engine: GPL-3.0
- Copyright notices and license files are preserved in this repository.

Vela Browser is an independent fork and is not affiliated with or endorsed by the upstream project or its maintainers.

## Development

Requirements:

- Bun
- Rust and Tauri prerequisites for desktop builds

```sh
bun install
bun test
bun cli.ts start
```

Desktop build:

```sh
bun run desktop:prepare
bun run desktop:build:nsis
```
