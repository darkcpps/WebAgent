export type ProviderId = 'chatgpt' | 'gemini' | 'zai';

export type ApprovalMode = 'view-only' | 'ask-before-action' | 'auto-apply-safe-edits';

export type SessionStatus = 'idle' | 'running' | 'waiting-approval' | 'stopped' | 'done' | 'error';

export interface ChatModel {
  id: string;
  label: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  modelId?: string;
  rawContent?: string;
}

export interface LogEntry {
  id: string;
  level: 'info' | 'warning' | 'error' | 'success';
  source: 'system' | 'provider' | 'agent' | 'workspace' | 'terminal';
  message: string;
  timestamp: number;
}

export interface ActionRecord {
  id: string;
  type: string;
  summary: string;
  status: 'pending' | 'approved' | 'rejected' | 'running' | 'done' | 'error';
  requiresApproval: boolean;
  preview?: string;
  result?: string;
}

export interface SessionState {
  id: string;
  providerId: ProviderId;
  providerSessionId?: string;
  lastPromptMode?: 'chat' | 'agent';
  task: string;
  workspaceRoot?: string;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
  logs: LogEntry[];
  actionHistory: ActionRecord[];
  approvalRequest?: ApprovalRequest;
  rawResponses: string[];
  chatHistory: ChatMessage[];
}

export interface ApprovalRequest {
  actionId: string;
  type: string;
  summary: string;
  preview?: string;
}

export interface BridgeUiState {
  transport: 'bridge' | 'playwright';
  autoStartCompanion: boolean;
  companionReachable: boolean;
  companionOwnedByExtension: boolean;
  browserConnected: boolean;
  ready: boolean;
  loginRequired: boolean;
  lastError?: string;
}

export interface WebviewState {
  sessions: SessionState[];
  activeSessionId?: string;
  providers: ProviderId[];
  providerModels: Record<ProviderId, ChatModel[]>;
  providerReady: Record<ProviderId, boolean>;
  approvalMode: ApprovalMode;
  bridge: BridgeUiState;
}
