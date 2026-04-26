export type ProviderId = 'chatgpt' | 'gemini' | 'perplexity';

export type ApprovalMode = 'view-only' | 'ask-before-action' | 'auto-apply-safe-edits';

export type SessionStatus = 'idle' | 'running' | 'waiting-approval' | 'stopped' | 'done' | 'error';

export interface ChatModel {
  id: string;
  label: string;
}

export interface ImageAttachment {
  name: string;
  mimeType: string;
  data: string;
}

export interface ProviderModelRefreshStatus {
  status: 'idle' | 'loading' | 'success' | 'error';
  message?: string;
  lastUpdated?: number;
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

export interface PendingPlan {
  originalRequest: string;
  plan: string;
  createdAt: number;
}

export interface SessionState {
  id: string;
  providerId: ProviderId;
  providerSessionId?: string;
  lastPromptMode?: 'chat' | 'agent' | 'plan';
  task: string;
  workspaceRoot?: string;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
  logs: LogEntry[];
  actionHistory: ActionRecord[];
  approvalRequest?: ApprovalRequest;
  pendingPlan?: PendingPlan;
  rawResponses: string[];
  chatHistory: ChatMessage[];
}

export interface ApprovalRequest {
  actionId: string;
  type: string;
  summary: string;
  preview?: string;
}

export interface WebviewState {
  sessions: SessionState[];
  activeSessionId?: string;
  providers: ProviderId[];
  providerModels: Record<ProviderId, ChatModel[]>;
  modelRefreshStatus: Record<ProviderId, ProviderModelRefreshStatus>;
  providerReady: Record<ProviderId, boolean>;
  approvalMode: ApprovalMode;
}
