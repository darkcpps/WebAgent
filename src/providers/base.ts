import type { ChatModel, ProviderId } from '../shared/types';

export interface FileAttachment {
  name: string;
  content: string;
}

export interface ProviderPrompt {
  systemPrompt: string;
  userPrompt: string;
  enableThinking?: boolean;
}

export interface ProviderReadiness {
  ready: boolean;
  loginRequired: boolean;
}

export interface BridgeHealthStatus {
  companionReachable: boolean;
  browserConnected: boolean;
  ready: boolean;
  loginRequired: boolean;
  error?: string;
}

export type ProviderEvent =
  | { type: 'status'; message: string }
  | { type: 'delta'; text: string }
  | { type: 'done'; fullText: string }
  | { type: 'error'; message: string }
  | { type: 'metadata'; conversationId?: string; modelId?: string };

export interface ProviderAdapter {
  readonly id: ProviderId;
  listModels(): ChatModel[];
  refreshModels(): Promise<ChatModel[]>;
  selectModel(modelId: string): Promise<boolean>;
  login(): Promise<void>;
  logout(): Promise<boolean>;
  checkReady(): Promise<ProviderReadiness>;
  startNewConversation(): Promise<string | undefined>;
  openConversation(conversationId: string): Promise<boolean>;
  getCurrentConversationId(): Promise<string | undefined>;
  deleteConversation(conversationId: string): Promise<boolean>;
  isReady(): Promise<boolean>;
  sendPrompt(input: ProviderPrompt): Promise<void>;
  streamEvents(onEvent: (event: ProviderEvent) => void): Promise<void>;
  stop(): Promise<void>;
  resetConversation(): Promise<void>;
  attachContext?(files: FileAttachment[]): Promise<void>;
  getBridgeHealth?(): Promise<BridgeHealthStatus>;
}
