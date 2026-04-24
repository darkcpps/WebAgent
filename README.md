# WebAgent Code

WebAgent Code is a VS Code extension scaffold that lets you drive website-based AI chat providers as agentic coding assistants inside the editor.

## What is included

- VS Code extension host with command + tree view registration
- React webview chat/control panel
- Workspace tools for listing, reading, searching, and summarising files
- Git status/diff collection
- Safe action protocol with zod validation
- Approval flow for risky actions
- Terminal command runner with streamed logs
- Playwright-based provider adapter layer for website chat UIs
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
- Perplexity web

They all share the same Playwright-based base class. Selector maps live in `src/providers/selector-registry.ts`.

## Approval modes

- `view-only`
- `ask-before-action`
- `auto-apply-safe-edits`

## Notes

- Use the provider login command first if the provider page is not already authenticated.
- Keep browser automation visible during development because website login/selector problems are much easier to debug that way.
- For production hardening, add better DOM health checks, retries, and provider-specific response finish detection.
