# Repository Guidelines

## Project Structure & Module Organization

This repository contains a VS Code extension for driving web-based AI providers from inside the editor. Source code lives in `src/`, with extension entry points in `src/extension.ts` and `src/extensionClean.ts`. Agent flow code is in `src/agent/`, provider automation in `src/providers/`, VS Code services in `src/services/`, workspace and terminal helpers in `src/workspace/` and `src/terminal/`, and shared utilities in `src/shared/`. The React webview is under `src/webview/`, with styles in `src/webview/styles/`. Static assets live in `resources/`. Treat `dist/` as generated output.

## Build, Test, and Development Commands

- `npm install`: install dependencies from `package-lock.json`.
- `npm run build`: bundle the extension and webview with `esbuild.js`.
- `npm run watch`: rebuild continuously during extension development.
- `npm run check`: run TypeScript type checking with `tsc --noEmit`.
- `npm run package`: build and create a VSIX package with `vsce`.

For local development, run `npm run build`, open the folder in VS Code, press `F5`, then run `WebAgent Code: Open Panel`.

## Coding Style & Naming Conventions

Use TypeScript for extension code and TSX for React webview components. Keep module names descriptive and camelCase, matching files such as `mcpManager.ts`, `diffPreviewService.ts`, and `sessionTreeProvider.ts`. Use PascalCase for React components and types, and camelCase for functions, variables, and service instances. Follow the existing style: two-space indentation in JSON, semicolons in TypeScript, and explicit local imports.

## Testing Guidelines

There is currently no automated test script. Before submitting changes, run `npm run check` and `npm run build`. For provider or webview changes, manually verify the extension host flow with `F5`, including login commands, provider selection, streamed responses, and approval prompts. If tests are added, place them near the relevant module or under `src/**/__tests__/`, and name files after the unit under test, for example `parser.test.ts`.

## Commit & Pull Request Guidelines

Recent commits use short, plain-English summaries such as `Restore live tool status updates in chat` and `Chatgpt Works now`. Prefer imperative, specific commit messages like `Fix provider response detection` or `Add MCP server refresh action`. Pull requests should include a concise description, manual verification steps, linked issues when applicable, and screenshots or screen recordings for visible webview changes.

## Security & Configuration Tips

Do not commit provider credentials, browser profiles, local MCP secrets, or generated VSIX files. Configuration defaults are declared in `package.json` under `contributes.configuration`; keep setting names under the `webagentCode.*` namespace and document user-visible behavior in the description field.
