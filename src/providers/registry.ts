import * as vscode from 'vscode';
import type { ProviderId } from '../shared/types';
import type { ProviderAdapter } from './base';
import { ChatGPTWebAdapter } from './chatgpt-web';
import { GeminiWebAdapter } from './gemini-web';
import { PerplexityWebAdapter } from './perplexity-web';

export class ProviderRegistry {
  private readonly providers = new Map<ProviderId, ProviderAdapter>();

  constructor(context: vscode.ExtensionContext) {
    this.providers.set('chatgpt', new ChatGPTWebAdapter(context));
    this.providers.set('gemini', new GeminiWebAdapter(context));
    this.providers.set('perplexity', new PerplexityWebAdapter(context));
  }

  list(): ProviderId[] {
    return ['chatgpt', 'gemini', 'perplexity'];
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
