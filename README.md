# Vela Browser

Vela Browser is an open-source, local-first browser profile manager and anti-detect browser.

The application opens directly into a local workspace. Vela has no product accounts, login, Cloud mode, team memberships, or remote MCP connectors. Environment data, website login details, cookies, proxies, and fingerprint identities stay on this computer. Local automation and MCP remain available.

Existing Local, Cloud, and first-run configurations migrate to the local workspace without changing local profiles. Old Cloud caches and recovery archives are preserved for offline recovery; they are not automatically merged into the local profile database. Retired account APIs return HTTP 410.

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
