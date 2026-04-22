# WebAgent Code

WebAgent Code is a VS Code extension scaffold that lets you drive website-based AI chat models such as ChatGPT, Gemini, and z.ai as agentic coding assistants inside the editor.

## What is included

- VS Code extension host with command + tree view registration
- React webview chat/control panel
- Workspace tools for listing, reading, searching, and summarising files
- Git status/diff collection
- Safe action protocol with zod validation
- Approval flow for risky actions
- Terminal command runner with streamed logs
- Playwright-based provider adapter layer for website chat UIs
- z.ai local browser-bridge transport (no provider APIs)
- Multi-turn orchestrator loop
- Session persistence using VS Code global state

## Current state

This is an MVP-oriented scaffold. The architecture is real and the core loop is implemented, but website adapters are inherently fragile and will need selector updates over time.

## Getting started

1. `npm install`
2. `npm run build`
3. Open this folder in VS Code
4. Press `F5` to launch the extension host
5. Run `WebAgent Code: Open Panel`

## Providers

Implemented adapters:

- ChatGPT web
- Gemini web
- z.ai web (bridge default, Playwright fallback)

They all share the same Playwright-based base class. Selector maps live in `src/providers/selector-registry.ts`.
z.ai additionally supports a local bridge adapter (`src/providers/zai-bridge.ts`) with a companion server + browser extension.

## z.ai bridge setup (no API keys)

1. Install deps: `cmd /c npm install`
2. Load unpacked extension from `resources/zai-browser-extension` in Chrome/Edge Developer Mode
3. Start companion: `cmd /c npm run bridge:companion` (optional once auto-start is enabled)
4. In VS Code settings, keep `webagentCode.transport.zai = auto` (default)
5. Optional health check: `cmd /c npm run bridge:doctor`

Quick helper script: `.\scripts\install-zai-bridge.ps1`

### Transport controls

- `webagentCode.transport.zai`: `auto | bridge | playwright` (`auto` prefers managed Playwright runtime)
- `webagentCode.zai.runtimeMode`: `headless | visible` for managed runtime
- `webagentCode.bridge.autoReconnect`: reconnect bridge socket automatically
- `webagentCode.bridge.requestTimeoutMs`: RPC timeout for bridge requests
- `webagentCode.bridge.autoStartCompanion`: start local companion automatically from extension (default `true`)

### UX notes for auto-start

- On extension activation, z.ai bridge companion auto-starts when `transport.zai=bridge` and auto-start is enabled.
- If bridge fails for a chat, you still get one-click Playwright fallback for that session.
- Sidebar now includes a **z.ai Bridge** control card with live status (companion/browser/ready) and one-click Start/Restart/Stop/Open actions.
- Manual controls are available in Command Palette:
  - `WebAgent Code: Start Bridge Companion`
  - `WebAgent Code: Stop Bridge Companion`
  - `WebAgent Code: Restart Bridge Companion`

If bridge is unhealthy during chat, extension offers one-click switch to Playwright for that session.

If browser extension shows `ERR_CONNECTION_REFUSED` for `ws://127.0.0.1:17833/ws`, companion is not reachable yet.
Start or restart companion (`npm run bridge:companion`) and confirm with `npm run bridge:doctor`.

## Approval modes

- `view-only`
- `ask-before-action`
- `auto-apply-safe-edits`

## Notes

- Use the provider login command first if the provider page is not already authenticated.
- Keep browser automation visible during development because website login/selector problems are much easier to debug that way.
- For production hardening, add better DOM health checks, retries, and provider-specific response finish detection.
