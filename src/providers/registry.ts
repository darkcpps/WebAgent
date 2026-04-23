import * as vscode from 'vscode';
import type { ProviderId, ZaiManagedMode, ZaiRuntime, ZaiTransport } from '../shared/types';
import type { ProviderAdapter } from './base';
import { ChatGPTWebAdapter } from './chatgpt-web';
import { GeminiWebAdapter } from './gemini-web';
import { ZaiBridgeAdapter } from './zai-bridge';
import { ZAIWebAdapter } from './zai-web';
import { PerplexityWebAdapter } from './perplexity-web';

export class ProviderRegistry {
  private readonly providers = new Map<Exclude<ProviderId, 'zai'>, ProviderAdapter>();
  private readonly zaiPlaywright: ProviderAdapter;
  private readonly zaiBridge: ProviderAdapter;
  private readonly zaiSessionOverrides = new Map<string, ZaiTransport>();

  constructor(context: vscode.ExtensionContext) {
    this.providers.set('chatgpt', new ChatGPTWebAdapter(context));
    this.providers.set('gemini', new GeminiWebAdapter(context));
    this.providers.set('perplexity', new PerplexityWebAdapter(context));
    this.zaiPlaywright = new ZAIWebAdapter(context);
    this.zaiBridge = new ZaiBridgeAdapter(context);
  }

  list(): ProviderId[] {
    return ['chatgpt', 'gemini', 'perplexity', 'zai'];
  }

  get(providerId: ProviderId, options?: { sessionId?: string }): ProviderAdapter {
    if (providerId === 'zai') {
      const runtime = this.resolveZaiRuntime(options?.sessionId);
      return runtime === 'playwright' ? this.zaiPlaywright : this.zaiBridge;
    }

    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`Unknown provider: ${providerId}`);
    }
    return provider;
  }

  getZaiTransport(sessionId?: string): ZaiTransport {
    if (sessionId) {
      const override = this.zaiSessionOverrides.get(sessionId);
      if (override) {
        return override;
      }
    }

    const configured = vscode.workspace.getConfiguration('webagentCode').get<string>('transport.zai', 'auto');
    if (configured === 'bridge' || configured === 'playwright' || configured === 'auto') {
      return configured;
    }
    return 'auto';
  }

  resolveZaiRuntime(sessionId?: string): ZaiRuntime {
    const transport = this.getZaiTransport(sessionId);
    if (transport === 'auto') {
      return 'playwright';
    }
    return transport;
  }

  getZaiManagedMode(): ZaiManagedMode {
    const configured = vscode.workspace.getConfiguration('webagentCode').get<string>('zai.runtimeMode', 'headless');
    return configured === 'visible' ? 'visible' : 'headless';
  }

  setZaiSessionTransport(sessionId: string, transport: ZaiTransport): void {
    if (!sessionId) {
      return;
    }
    this.zaiSessionOverrides.set(sessionId, transport);
  }

  clearZaiSessionTransport(sessionId: string): void {
    this.zaiSessionOverrides.delete(sessionId);
  }
}
