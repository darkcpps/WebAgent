import type { ApprovalMode, ProviderId, WebviewState } from './types';

export type WebviewToExtensionMessage =
  | { type: 'ready' }
  | { type: 'newChat'; providerId: ProviderId }
  | { type: 'deleteChat'; sessionId: string }
  | { type: 'startTask'; providerId: ProviderId; task: string }
  | {
      type: 'sendChat';
      providerId: ProviderId;
      sessionId?: string;
      message: string;
      modelId?: string;
      agentMode?: boolean;
      planningMode?: boolean;
      enableThinking?: boolean;
    }
  | {
      type: 'regenerateChatInNewSession';
      providerId: ProviderId;
      sourceSessionId: string;
      message: string;
      modelId?: string;
      agentMode?: boolean;
      planningMode?: boolean;
      enableThinking?: boolean;
    }
  | { type: 'stopTask'; sessionId: string }
  | { type: 'loginProvider'; providerId: ProviderId }
  | { type: 'logoutProvider'; providerId: ProviderId }
  | { type: 'checkProviderReady'; providerId: ProviderId; silent?: boolean }
  | { type: 'refreshProviderModels'; providerId: ProviderId }
  | { type: 'resetConversation'; providerId: ProviderId }
  | { type: 'approve'; sessionId: string; actionId: string }
  | { type: 'reject'; sessionId: string; actionId: string }
  | { type: 'setActiveSession'; sessionId: string }
  | { type: 'setApprovalMode'; mode: ApprovalMode }
  | { type: 'previewSessionChanges'; sessionId: string }
  | { type: 'refreshState' };

export type ExtensionToWebviewMessage =
  | { type: 'state'; state: WebviewState }
  | { type: 'toast'; level: 'info' | 'warning' | 'error' | 'success'; message: string };
