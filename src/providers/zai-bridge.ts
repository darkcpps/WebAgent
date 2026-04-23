import * as vscode from 'vscode';
import type { ChatModel } from '../shared/types';
import type { BridgeHealthStatus, ProviderAdapter, ProviderEvent, ProviderPrompt, ProviderReadiness } from './base';
import { ZaiBridgeClient } from './bridge/client';

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

interface ParsedModelResponse {
  models: ChatModel[];
  selectedModelId?: string;
  defaultModelId?: string;
}

function parseModelResponse(value: unknown): ParsedModelResponse {
  const container = value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  const rawEntries = container && Array.isArray(container.models) ? container.models : Array.isArray(value) ? value : [];
  const parsed: ChatModel[] = [];
  const seen = new Set<string>();

  for (const entry of rawEntries) {
    if (typeof entry === 'string') {
      const normalized = entry.trim();
      if (!normalized) {
        continue;
      }
      const key = normalized.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      parsed.push({ id: normalized, label: normalized });
      continue;
    }

    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const idCandidate = [
      record.id,
      record.model_id,
      record.modelId,
      record.backend_id,
      record.backendId,
      record.value,
      record.code,
      record.model,
      record.key,
      record.name,
    ].find((item) => typeof item === 'string') as string | undefined;
    const labelCandidate = [
      record.name,
      record.label,
      record.display_name,
      record.displayName,
      record.title,
      record.model_name,
      record.text,
      record.id,
    ].find((item) => typeof item === 'string') as string | undefined;

    const id = (idCandidate || labelCandidate || '').trim();
    const label = (labelCandidate || idCandidate || '').trim();
    if (!id || !label) {
      continue;
    }

    const key = id.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    parsed.push({ id, label });
  }

  const selectedModelId =
    asString(container?.selectedModelId) ||
    asString(container?.selected_model_id) ||
    asString(container?.selectedModel) ||
    asString(container?.selected_model);
  const defaultModelId =
    asString(container?.defaultModelId) ||
    asString(container?.default_model_id) ||
    asString(container?.defaultModel) ||
    asString(container?.default_model);

  return { models: parsed, selectedModelId, defaultModelId };
}

export class ZaiBridgeAdapter implements ProviderAdapter {
  readonly id = 'zai' as const;
  private readonly client: ZaiBridgeClient;
  private modelsCache: ChatModel[] = [{ id: 'auto', label: 'Auto' }];
  private lastBridgeError?: string;
  private healthCache?: { status: BridgeHealthStatus; timestamp: number };
  private activeStreamId?: string;
  private selectedModelId?: string;
  private selectedModelLabel?: string;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.client = new ZaiBridgeClient(context);
  }

  listModels(): ChatModel[] {
    return this.modelsCache;
  }

  async refreshModels(): Promise<ChatModel[]> {
    const result = await this.client.request('listModels');
    this.lastBridgeError = undefined;
    const parsed = parseModelResponse(result);
    const labels = parsed.models;
    if (labels.length > 0) {
      this.modelsCache = [{ id: 'auto', label: 'Auto' }, ...labels];
      const selectableIds = new Set(labels.map((model) => model.id.toLowerCase()));
      const preferredSelected = parsed.selectedModelId || this.selectedModelId;
      if (preferredSelected && selectableIds.has(preferredSelected.toLowerCase())) {
        const active = labels.find((model) => model.id.toLowerCase() === preferredSelected.toLowerCase());
        this.selectedModelId = active?.id;
        this.selectedModelLabel = active?.label;
      } else if (parsed.defaultModelId && selectableIds.has(parsed.defaultModelId.toLowerCase())) {
        const fallback = labels.find((model) => model.id.toLowerCase() === parsed.defaultModelId?.toLowerCase());
        this.selectedModelId = fallback?.id;
        this.selectedModelLabel = fallback?.label;
      } else if (this.selectedModelId && !selectableIds.has(this.selectedModelId.toLowerCase())) {
        const first = labels[0];
        this.selectedModelId = first?.id;
        this.selectedModelLabel = first?.label;
        console.warn(
          `[zai-bridge] Saved model no longer exists. Falling back to ${this.selectedModelLabel || this.selectedModelId || 'Auto'}.`,
        );
      }
      console.log(
        `[zai-bridge] Models fetched: ${labels
          .map((model) => `${model.label} (${model.id})`)
          .slice(0, 20)
          .join(', ')}`,
      );
      if (this.selectedModelId) {
        console.log(`[zai-bridge] Active model: ${this.selectedModelLabel || this.selectedModelId} (${this.selectedModelId})`);
      }
    } else {
      console.warn('[zai-bridge] /api/models returned no models. Keeping existing model cache.');
    }
    return this.modelsCache;
  }

  async selectModel(modelId: string): Promise<boolean> {
    if (!modelId || modelId === 'auto') {
      this.selectedModelId = undefined;
      this.selectedModelLabel = undefined;
      return true;
    }
    const result = await this.client.request('selectModel', {
      modelId,
      modelLabel: this.modelsCache.find((model) => model.id === modelId)?.label,
    });
    this.lastBridgeError = undefined;
    const ok = asBoolean((result as { ok?: unknown } | undefined)?.ok ?? result);
    if (ok) {
      const active = this.modelsCache.find((model) => model.id === modelId);
      this.selectedModelId = modelId;
      this.selectedModelLabel = active?.label;
      console.log(`[zai-bridge] Selected model: ${this.selectedModelLabel || modelId} (${modelId})`);
    }
    return ok;
  }

  async login(): Promise<void> {
    await this.client.request('health', { openHome: true });
    this.lastBridgeError = undefined;
    await vscode.window.showInformationMessage('Open z.ai in your browser tab and complete login if needed.');
  }

  async logout(): Promise<boolean> {
    // No reliable sign-out flow through the local browser bridge.
    return false;
  }

  async checkReady(): Promise<ProviderReadiness> {
    try {
      const result = await this.client.request('checkReady');
      const payload = (result as { ready?: unknown; loginRequired?: unknown } | undefined) ?? {};
      this.lastBridgeError = undefined;
      return {
        ready: asBoolean(payload.ready),
        loginRequired: asBoolean(payload.loginRequired),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/\[bridge\]/i.test(message)) {
        this.lastBridgeError = message;
        return { ready: false, loginRequired: false };
      }
      throw error;
    }
  }

  async startNewConversation(): Promise<string | undefined> {
    const result = await this.client.request('startNewConversation');
    this.lastBridgeError = undefined;
    return asString((result as { conversationId?: unknown } | undefined)?.conversationId ?? result);
  }

  async openConversation(conversationId: string): Promise<boolean> {
    if (!conversationId.trim()) {
      return false;
    }
    try {
      const result = await this.client.request('openConversation', { conversationId });
      this.lastBridgeError = undefined;
      const payload = result as { opened?: boolean; navigating?: boolean } | undefined;
      const opened = payload?.opened ?? asBoolean(result);
      
      if (opened && payload?.navigating) {
        // Wait for page to reload and bridge content script to reconnect.
        await new Promise(r => setTimeout(r, 2000));
        for (let i = 0; i < 15; i++) {
          try {
            const readiness = await this.checkReady();
            if (readiness.ready) break;
          } catch {
            // ignore while reconnecting
          }
          await new Promise(r => setTimeout(r, 1000));
        }
      }
      return opened;
    } catch {
      // If it threw, it might mean the connection closed *during* the request because of navigation.
      // We assume it's attempting to navigate.
      return true;
    }
  }

  async getCurrentConversationId(): Promise<string | undefined> {
    const result = await this.client.request('getCurrentConversationId');
    this.lastBridgeError = undefined;
    return asString((result as { conversationId?: unknown } | undefined)?.conversationId ?? result);
  }

  async deleteConversation(_conversationId: string): Promise<boolean> {
    // Bridge mode does not implement destructive remote delete yet.
    return false;
  }

  async isReady(): Promise<boolean> {
    const readiness = await this.checkReady();
    return readiness.ready;
  }

  async sendPrompt(input: ProviderPrompt): Promise<void> {
    await this.client.request('sendPrompt', {
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
      modelId: this.selectedModelId,
      enableThinking: input.enableThinking,
    });
    this.lastBridgeError = undefined;
    if (this.selectedModelId) {
      console.log(
        `[zai-bridge] sendPrompt queued with model ${this.selectedModelLabel || this.selectedModelId} (${this.selectedModelId}).`,
      );
    }
  }

  async streamEvents(onEvent: (event: ProviderEvent) => void): Promise<void> {
    const started = (await this.client.request('streamStart')) as { streamId?: unknown } | undefined;
    this.lastBridgeError = undefined;
    const streamId = asString(started?.streamId);
    if (!streamId) {
      throw new Error('[bridge] streamStart did not return a streamId.');
    }

    this.activeStreamId = streamId;
    onEvent({ type: 'status', message: 'Waiting for z.ai response...' });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error('[bridge] Streaming timed out.'));
      }, 240000);

      const unsubscribe = this.client.subscribeStream(streamId, (event) => {
        if (event.type === 'error') {
          clearTimeout(timeout);
          unsubscribe();
          reject(new Error(event.message));
          return;
        }

        onEvent(event);
        if (event.type === 'done') {
          clearTimeout(timeout);
          unsubscribe();
          resolve();
        }
      });
    });
  }

  async stop(): Promise<void> {
    const streamId = this.activeStreamId;
    this.activeStreamId = undefined;
    await this.client.request('stop', streamId ? { streamId } : undefined).catch(() => undefined);
  }

  async resetConversation(): Promise<void> {
    await this.startNewConversation();
  }

  async getBridgeHealth(): Promise<BridgeHealthStatus> {
    const CACHE_TTL = 3000; // 3 seconds
    if (this.healthCache && Date.now() - this.healthCache.timestamp < CACHE_TTL) {
      return this.healthCache.status;
    }

    try {
      const result = (await this.client.request('health', { openHome: false })) as
        | { companionReachable?: unknown; browserConnected?: unknown; ready?: unknown; loginRequired?: unknown }
        | undefined;

      const browserConnected = asBoolean(result?.browserConnected);
      let ready = asBoolean(result?.ready);
      let loginRequired = asBoolean(result?.loginRequired);

      if (browserConnected) {
        try {
          const readiness = await this.checkReady();
          ready = readiness.ready;
          loginRequired = readiness.loginRequired;
        } catch {
          // Keep best-effort health values.
        }
      }

      const health: BridgeHealthStatus = {
        companionReachable: result?.companionReachable === undefined ? true : asBoolean(result?.companionReachable),
        browserConnected,
        ready,
        loginRequired,
        error: undefined,
      };
      this.lastBridgeError = undefined;
      this.healthCache = { status: health, timestamp: Date.now() };
      return health;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastBridgeError = message;
      const errorHealth: BridgeHealthStatus = {
        companionReachable: false,
        browserConnected: false,
        ready: false,
        loginRequired: false,
        error: message,
      };
      this.healthCache = { status: errorHealth, timestamp: Date.now() };
      return errorHealth;
    }
  }
}
