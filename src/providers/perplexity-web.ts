import * as vscode from 'vscode';
import type { ChatModel } from '../shared/types';
import type { ProviderEvent, ProviderPrompt, ProviderReadiness } from './base';
import { PlaywrightWebProvider } from './playwrightBase';

type QueueResolver = (event: ProviderEvent) => void;
interface PendingWaiter {
  resolve: QueueResolver;
  timer?: ReturnType<typeof setTimeout>;
}

export class PerplexityWebAdapter extends PlaywrightWebProvider {
  private static readonly INITIAL_STREAM_EVENT_TIMEOUT_MS = 45000;
  private static readonly INTER_EVENT_TIMEOUT_MS = 90000;
  private readonly queue: ProviderEvent[] = [];
  private readonly waiters: PendingWaiter[] = [];
  private modelCache: ChatModel[] = [{ id: 'auto', label: 'Auto' }];
  private bindingsInstalled = false;

  constructor(context: vscode.ExtensionContext) {
    super('perplexity', context);
  }

  override listModels(): ChatModel[] {
    return this.modelCache;
  }

  override async refreshModels(): Promise<ChatModel[]> {
    const genericDiscovered = await super.refreshModels();
    if (genericDiscovered.length > 1) {
      this.modelCache = genericDiscovered;
      return this.modelCache;
    }

    await this.ensurePage(false);
    await this.ensureOnOrigin();

    let labels = await this.extractRadixModelLabels();
    if (labels.length === 0) {
      labels = await this.openPickerAndExtractRadixLabels();
    }

    if (labels.length > 0) {
      this.modelCache = this.toPerplexityModelList(labels);
    }

    return this.modelCache;
  }

  override async selectModel(modelId: string): Promise<boolean> {
    const selected = await super.selectModel(modelId);
    if (!selected || !modelId || modelId === 'auto') {
      return selected;
    }

    if (!this.modelCache.some((model) => model.id === modelId)) {
      this.modelCache = [...this.modelCache, { id: modelId, label: modelId }];
    }
    return selected;
  }

  override async checkReady(): Promise<ProviderReadiness> {
    await this.ensurePage(false);
    await this.ensureOnOrigin();

    const sessionState = await this.page!.evaluate(async () => {
      try {
        const response = await fetch('/api/auth/session', { credentials: 'include' });
        if (!response.ok) {
          return { hasUser: false, hasPayload: false };
        }
        const payload = (await response.json()) as { user?: Record<string, unknown> } | null;
        const user = payload?.user;
        const hasUser =
          Boolean(user) &&
          ['id', 'email', 'name', 'image'].some((field) => typeof user?.[field] === 'string' && user[field]!.trim().length > 0);

        const hasPayload = Boolean(payload && typeof payload === 'object' && Object.keys(payload).length > 0);
        return { hasUser, hasPayload };
      } catch {
        return { hasUser: false, hasPayload: false };
      }
    });

    if (sessionState.hasUser) {
      return { ready: true, loginRequired: false };
    }

    const domFallback = await super.checkReady();
    if (domFallback.ready) {
      return { ready: true, loginRequired: false };
    }

    // When session payload exists but user details are omitted, prefer the DOM signal.
    if (sessionState.hasPayload) {
      return domFallback;
    }

    return domFallback;
  }

  override async startNewConversation(): Promise<string | undefined> {
    await this.ensurePage(false);
    await this.page!.goto(this.selectorMap.homeUrl, { waitUntil: 'domcontentloaded' });
    return undefined;
  }

  override async openConversation(conversationId: string): Promise<boolean> {
    if (!conversationId.trim()) {
      return false;
    }

    await this.ensurePage(false);
    const target = `${this.selectorMap.homeUrl.replace(/\/+$/, '')}/search/${conversationId}`;
    await this.page!.goto(target, { waitUntil: 'domcontentloaded' });
    return this.getConversationIdFromUrl(this.page!.url()) === conversationId;
  }

  override async getCurrentConversationId(): Promise<string | undefined> {
    await this.ensurePage(false);
    return this.getConversationIdFromUrl(this.page!.url());
  }

  override async sendPrompt(input: ProviderPrompt): Promise<void> {
    await this.ensurePage(false);
    await this.ensureHookInstalled();
    await this.page!
      .evaluate((enabled) => {
        const scope = globalThis as typeof globalThis & { __webagentPerplexityEnableThinking?: boolean };
        if (typeof enabled === 'boolean') {
          scope.__webagentPerplexityEnableThinking = enabled;
          return;
        }
        delete scope.__webagentPerplexityEnableThinking;
      }, input.enableThinking)
      .catch(() => undefined);
    this.resetQueue();
    await super.sendPrompt(input);
  }

  override async streamEvents(onEvent: (event: ProviderEvent) => void): Promise<void> {
    onEvent({ type: 'status', message: 'Waiting for perplexity response...' });
    let sawEvent = false;
    while (true) {
      const event = await this.nextEvent(
        sawEvent ? PerplexityWebAdapter.INTER_EVENT_TIMEOUT_MS : PerplexityWebAdapter.INITIAL_STREAM_EVENT_TIMEOUT_MS,
      );
      sawEvent = true;
      onEvent(event);
      if (event.type === 'done' || event.type === 'error') {
        return;
      }
    }
  }

  override async stop(): Promise<void> {
    await super.stop();
    if (this.page && !this.page.isClosed()) {
      await this.page
        .evaluate(() => {
          const scope = globalThis as typeof globalThis & { __webagentPerplexityAbort?: AbortController };
          scope.__webagentPerplexityAbort?.abort();
        })
        .catch(() => undefined);
    }
  }

  override async resetConversation(): Promise<void> {
    await this.startNewConversation();
  }

  private async ensureOnOrigin(): Promise<void> {
    const current = this.page?.url() || '';
    const origin = new URL(this.selectorMap.homeUrl).origin;
    if (!current || current === 'about:blank' || !current.startsWith(origin)) {
      await this.page!.goto(this.selectorMap.homeUrl, { waitUntil: 'domcontentloaded' });
    }
  }

  private async openPickerAndExtractRadixLabels(): Promise<string[]> {
    const pickerCandidates = [
      'button[aria-label*="Model"]',
      '[role="combobox"]',
      'button[aria-haspopup="menu"]:has(span[translate="no"])',
      'button:has-text("Best")',
    ];

    for (const selector of pickerCandidates) {
      const trigger = this.page!.locator(selector).first();
      try {
        if ((await trigger.count()) === 0 || !(await trigger.isVisible())) {
          continue;
        }

        await trigger.click().catch(() => undefined);
        await this.page!.waitForTimeout(250);
        const labels = await this.extractRadixModelLabels();
        await this.page!.keyboard.press('Escape').catch(() => undefined);
        if (labels.length > 0) {
          return labels;
        }
      } catch {
        // Ignore and continue with next candidate.
      }
    }

    return [];
  }

  private async extractRadixModelLabels(): Promise<string[]> {
    return this.page!
      .evaluate(() => {
        const labels = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemradio"] [translate="no"]'))
          .map((node) => (node.textContent || '').trim())
          .filter((value) => value.length >= 2 && value.length <= 80);
        return Array.from(new Set(labels));
      })
      .catch(() => []);
  }

  private toPerplexityModelList(labels: string[]): ChatModel[] {
    const deduped = new Map<string, ChatModel>();
    for (const rawLabel of labels) {
      const label = rawLabel.trim().replace(/\s+/g, ' ');
      if (!label) {
        continue;
      }
      const key = label.toLowerCase();
      if (!deduped.has(key)) {
        deduped.set(key, { id: label, label });
      }
    }
    return [{ id: 'auto', label: 'Auto' }, ...deduped.values()];
  }

  private getConversationIdFromUrl(url: string): string | undefined {
    try {
      const parsed = new URL(url);
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts[0] !== 'search' || parts.length < 2) {
        return undefined;
      }
      if (parts[1] === 'new') {
        return undefined;
      }
      return parts[1];
    } catch {
      return undefined;
    }
  }

  private resetQueue(): void {
    this.queue.length = 0;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (waiter?.timer) {
        clearTimeout(waiter.timer);
      }
      waiter?.resolve({ type: 'error', message: 'Previous Perplexity stream was replaced by a new request.' });
    }
  }

  private pushEvent(event: ProviderEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      if (waiter.timer) {
        clearTimeout(waiter.timer);
      }
      waiter.resolve(event);
      return;
    }
    this.queue.push(event);
  }

  private nextEvent(timeoutMs = PerplexityWebAdapter.INTER_EVENT_TIMEOUT_MS): Promise<ProviderEvent> {
    const queued = this.queue.shift();
    if (queued) {
      return Promise.resolve(queued);
    }
    return new Promise((resolve) => {
      const waiter: PendingWaiter = { resolve };
      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) {
            this.waiters.splice(index, 1);
          }
          resolve({ type: 'error', message: `Perplexity response timed out after ${Math.round(timeoutMs / 1000)}s.` });
        }, timeoutMs);
      }
      this.waiters.push(waiter);
    });
  }

  private async ensureHookInstalled(): Promise<void> {
    await this.ensurePage(false);
    await this.ensureOnOrigin();

    if (!this.bindingsInstalled && this.context) {
      await this.context
        .exposeBinding('__webagentPerplexityEmit', (_source, payload: unknown) => {
          const event = payload as ProviderEvent;
          this.pushEvent(event);
        })
        .catch(() => undefined);
      this.bindingsInstalled = true;
    }

    await this.page!
      .evaluate(() => {
        const scope = globalThis as typeof globalThis & {
          __webagentPerplexityHookInstalled?: boolean;
          __webagentPerplexityOriginalFetch?: typeof fetch;
          __webagentPerplexityAbort?: AbortController;
          __webagentPerplexityEmit?: (payload: unknown) => Promise<void>;
          __webagentPerplexityEnableThinking?: boolean;
        };

        if (scope.__webagentPerplexityHookInstalled) {
          return;
        }
        scope.__webagentPerplexityHookInstalled = true;
        scope.__webagentPerplexityOriginalFetch = scope.fetch.bind(scope);

        const decoder = new TextDecoder();

        const emit = async (event: unknown) => {
          try {
            await scope.__webagentPerplexityEmit?.(event);
          } catch {
            // Ignore callback failures.
          }
        };

        const applyThinkingPreference = (payload: unknown, enabled: boolean): boolean => {
          const isPlainObject = (value: unknown): value is Record<string, unknown> =>
            typeof value === 'object' && value !== null && !Array.isArray(value);
          if (!isPlainObject(payload)) {
            return false;
          }

          const visited = new Set<unknown>();
          let changed = false;
          const keyRegex = /(thinking|reasoning|reason)/i;

          const patchValue = (holder: Record<string, unknown>, key: string, value: unknown): void => {
            if (typeof value === 'boolean') {
              if (value !== enabled) {
                holder[key] = enabled;
                changed = true;
              }
              return;
            }
            if (typeof value === 'number') {
              if (value === 0 || value === 1) {
                const next = enabled ? 1 : 0;
                if (value !== next) {
                  holder[key] = next;
                  changed = true;
                }
              }
              return;
            }
            if (typeof value === 'string') {
              const lowered = value.trim().toLowerCase();
              if (/^(true|false)$/.test(lowered)) {
                const next = enabled ? 'true' : 'false';
                if (lowered !== next) {
                  holder[key] = next;
                  changed = true;
                }
                return;
              }
              if (/^(enabled|disabled)$/.test(lowered)) {
                const next = enabled ? 'enabled' : 'disabled';
                if (lowered !== next) {
                  holder[key] = next;
                  changed = true;
                }
                return;
              }
              if (/^(on|off)$/.test(lowered)) {
                const next = enabled ? 'on' : 'off';
                if (lowered !== next) {
                  holder[key] = next;
                  changed = true;
                }
              }
            }
          };

          const visit = (node: unknown, depth: number): void => {
            if (depth > 6 || typeof node !== 'object' || node === null || visited.has(node)) {
              return;
            }
            visited.add(node);

            if (Array.isArray(node)) {
              for (const item of node) {
                visit(item, depth + 1);
              }
              return;
            }

            const record = node as Record<string, unknown>;
            for (const [key, value] of Object.entries(record)) {
              if (keyRegex.test(key)) {
                patchValue(record, key, value);
              }
              visit(value, depth + 1);
            }
          };

          visit(payload, 0);
          return changed;
        };

        const consumeStream = async (stream: ReadableStream<Uint8Array>) => {
          const reader = stream.getReader();
          let buffer = '';
          let currentText = '';
          let chunks: string[] = [];

          const applyPatch = async (patch: { op?: string; path?: string; value?: unknown }) => {
            const patchPath = typeof patch.path === 'string' ? patch.path : '';
            if (patch.op === 'replace' && patchPath === '') {
              const root = patch.value as { chunks?: unknown[] } | undefined;
              if (root && Array.isArray(root.chunks)) {
                chunks = root.chunks.map((entry) => (typeof entry === 'string' ? entry : ''));
              }
            } else if ((patch.op === 'add' || patch.op === 'replace') && /^\/chunks\/\d+$/.test(patchPath)) {
              const index = Number(patchPath.split('/').pop());
              chunks[index] = typeof patch.value === 'string' ? patch.value : '';
            }

            const nextText = chunks.join('');
            if (nextText && nextText !== currentText) {
              const delta = nextText.startsWith(currentText) ? nextText.slice(currentText.length) : nextText;
              currentText = nextText;
              if (delta) {
                void emit({ type: 'delta', text: delta });
              }
            }
          };

          const handlePayload = async (payload: Record<string, unknown>) => {
            const slug = typeof payload.thread_url_slug === 'string' ? payload.thread_url_slug : undefined;
            if (slug) {
              await emit({ type: 'metadata', conversationId: slug });
            }

            const blocks = Array.isArray(payload.blocks) ? payload.blocks : [];
            for (const block of blocks) {
              const entry = block as { intended_usage?: string; diff_block?: { field?: string; patches?: unknown[] } };
              if (!entry || (entry.intended_usage !== 'ask_text' && entry.intended_usage !== 'ask_text_0_markdown')) {
                continue;
              }
              if (entry.diff_block?.field !== 'markdown_block' || !Array.isArray(entry.diff_block.patches)) {
                continue;
              }
              for (const rawPatch of entry.diff_block.patches) {
                await applyPatch((rawPatch || {}) as { op?: string; path?: string; value?: unknown });
              }
            }
          };

          try {
            while (true) {
              const result = await reader.read();
              if (result.done) {
                break;
              }

              buffer += decoder.decode(result.value, { stream: true }).replace(/\r\n/g, '\n');
              while (true) {
                const boundary = buffer.indexOf('\n\n');
                if (boundary === -1) {
                  break;
                }

                const block = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);
                const dataText = block
                  .split('\n')
                  .filter((line) => line.startsWith('data:'))
                  .map((line) => line.slice(5).trim())
                  .join('\n');

                if (!dataText) {
                  continue;
                }

                try {
                  const payload = JSON.parse(dataText) as Record<string, unknown>;
                  await handlePayload(payload);
                } catch {
                  // Ignore partial or non-JSON events.
                }
              }
            }
          } catch (error) {
            const aborted = error instanceof DOMException && error.name === 'AbortError';
            if (!aborted) {
              const message = error instanceof Error ? error.message : String(error);
              await emit({ type: 'error', message: `Perplexity stream failed: ${message}` });
              return;
            }
          }

          await emit({ type: 'done', fullText: currentText });
        };

        scope.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
          const isAskRequest = requestUrl.includes('/rest/sse/perplexity_ask');
          let nextInit = init;
          let thinkingApplied = false;
          const thinkingPreference =
            typeof scope.__webagentPerplexityEnableThinking === 'boolean' ? scope.__webagentPerplexityEnableThinking : undefined;

          if (isAskRequest && typeof thinkingPreference === 'boolean') {
            try {
              const sourceBody =
                typeof init?.body === 'string'
                  ? init.body
                  : input instanceof Request
                    ? await input.clone().text()
                    : undefined;
              if (sourceBody) {
                const parsed = JSON.parse(sourceBody) as unknown;
                thinkingApplied = applyThinkingPreference(parsed, thinkingPreference);
                if (thinkingApplied) {
                  nextInit = { ...(init || {}), body: JSON.stringify(parsed) };
                  void emit({
                    type: 'status',
                    message: `Perplexity reasoning ${thinkingPreference ? 'enabled' : 'disabled'} for this request.`,
                  });
                }
              }
            } catch {
              // If payload parsing fails, send the original request unchanged.
            }
          }

          let response: Response;
          try {
            response = await scope.__webagentPerplexityOriginalFetch!(input, nextInit);
          } catch (error) {
            if (isAskRequest) {
              const message = error instanceof Error ? error.message : String(error);
              await emit({ type: 'error', message: `Perplexity request failed: ${message}` });
            }
            throw error;
          }
          if (!isAskRequest || !response.body) {
            return response;
          }

          if (!thinkingApplied && thinkingPreference === true) {
            void emit({
              type: 'status',
              message: 'Perplexity reasoning toggle requested, but no compatible reasoning flag was detected in request payload.',
            });
          }

          const branches = response.body.tee();
          void consumeStream(branches[1]);
          return new Response(branches[0], {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        };
      })
      .catch(() => undefined);
  }
}
