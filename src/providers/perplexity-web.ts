import * as vscode from 'vscode';
import type { ChatModel } from '../shared/types';
import type { ProviderEvent, ProviderPrompt, ProviderReadiness } from './base';
import { PlaywrightWebProvider } from './playwrightBase';

type QueueResolver = (event: ProviderEvent) => void;

export class PerplexityWebAdapter extends PlaywrightWebProvider {
  private readonly queue: ProviderEvent[] = [];
  private readonly waiters: QueueResolver[] = [];
  private manualModelsCache: ChatModel[] = [{ id: 'auto', label: 'Auto' }];
  private selectedModelId?: string;
  private bindingsInstalled = false;

  constructor(context: vscode.ExtensionContext) {
    super('perplexity', context);
  }

  override listModels(): ChatModel[] {
    return this.manualModelsCache;
  }

  override async refreshModels(): Promise<ChatModel[]> {
    return this.manualModelsCache;
  }

  override async selectModel(modelId: string): Promise<boolean> {
    this.selectedModelId = modelId && modelId !== 'auto' ? modelId : undefined;
    if (this.selectedModelId && !this.manualModelsCache.some((model) => model.id === this.selectedModelId)) {
      this.manualModelsCache = [...this.manualModelsCache, { id: this.selectedModelId, label: this.selectedModelId }];
    }
    return true;
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
    this.resetQueue();
    await super.sendPrompt(input);
  }

  override async streamEvents(onEvent: (event: ProviderEvent) => void): Promise<void> {
    onEvent({ type: 'status', message: 'Waiting for perplexity response...' });
    while (true) {
      const event = await this.nextEvent();
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
      const resolve = this.waiters.shift();
      resolve?.({ type: 'error', message: 'Previous Perplexity stream was replaced by a new request.' });
    }
  }

  private pushEvent(event: ProviderEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(event);
      return;
    }
    this.queue.push(event);
  }

  private nextEvent(): Promise<ProviderEvent> {
    const queued = this.queue.shift();
    if (queued) {
      return Promise.resolve(queued);
    }
    return new Promise((resolve) => this.waiters.push(resolve));
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
          const response = await scope.__webagentPerplexityOriginalFetch!(input, init);
          if (!requestUrl.includes('/rest/sse/perplexity_ask') || !response.body) {
            return response;
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
