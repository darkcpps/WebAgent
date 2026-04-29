import * as vscode from 'vscode';
import type { ProviderId } from '../shared/types';
import type { ProviderAdapter } from './base';
import { ChatGPTWebAdapter } from './chatgpt-web';
import { DeepSeekWebAdapter } from './deepseek-web';
import { KimiWebAdapter } from './kimi-web';
import { PerplexityWebAdapter } from './perplexity-web';

export class ProviderRegistry {
  private readonly providers = new Map<ProviderId, ProviderAdapter>();

  constructor(context: vscode.ExtensionContext) {
    this.providers.set('chatgpt', new ChatGPTWebAdapter(context));
    this.providers.set('kimi', new KimiWebAdapter(context));
    this.providers.set('perplexity', new PerplexityWebAdapter(context));
    this.providers.set('deepseek', new DeepSeekWebAdapter(context));
  }

  list(): ProviderId[] {
    return ['chatgpt', 'kimi', 'perplexity', 'deepseek'];
  }

  get(providerId: ProviderId): ProviderAdapter;
  get(providerId: ProviderId, _options?: { sessionId?: string }): ProviderAdapter;
  get(providerId: ProviderId, _options?: { sessionId?: string }): ProviderAdapter {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`Unknown provider: ${providerId}`);
    }
    return provider;
  }
}
