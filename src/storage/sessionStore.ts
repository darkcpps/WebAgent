import * as vscode from 'vscode';
import type { ApprovalRequest, ChatMessage, LogEntry, SessionState, SessionStatus } from '../shared/types';
import { createId } from '../shared/utils';

const STORAGE_KEY = 'webagent-code.sessions';

export class SessionStore {
  private sessions = new Map<string, SessionState>();
  private activeSessionId?: string;
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();

  readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    const stored = context.globalState.get<SessionState[]>(STORAGE_KEY, []);
    for (const session of stored) {
      this.sessions.set(session.id, {
        ...session,
        providerSessionId: session.providerSessionId,
        rawResponses: session.rawResponses ?? [],
        chatHistory: session.chatHistory ?? [],
      });
    }
    this.activeSessionId = stored[0]?.id;
  }

  getAll(): SessionState[] {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  getActive(): SessionState | undefined {
    return this.activeSessionId ? this.sessions.get(this.activeSessionId) : this.getAll()[0];
  }

  setActive(sessionId: string | undefined): void {
    this.activeSessionId = sessionId;
    this.emit();
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = this.getAll()[0]?.id;
    }
    this.emit();
  }

  create(providerId: SessionState['providerId'], task: string, workspaceRoot?: string): SessionState {
    const session: SessionState = {
      id: createId('session'),
      providerId,
      task,
      workspaceRoot,
      status: 'idle',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      logs: [],
      actionHistory: [],
      rawResponses: [],
      chatHistory: [],
    };
    this.sessions.set(session.id, session);
    this.activeSessionId = session.id;
    this.emit();
    return session;
  }

  update(sessionId: string, patch: Partial<SessionState>): SessionState | undefined {
    const current = this.sessions.get(sessionId);
    if (!current) {
      return undefined;
    }
    const next: SessionState = {
      ...current,
      ...patch,
      updatedAt: Date.now(),
    };
    this.sessions.set(sessionId, next);
    this.emit();
    return next;
  }

  appendLog(sessionId: string, log: Omit<LogEntry, 'id' | 'timestamp'>): void {
    const current = this.sessions.get(sessionId);
    if (!current) {
      return;
    }
    current.logs = [
      ...current.logs,
      {
        ...log,
        id: createId('log'),
        timestamp: Date.now(),
      },
    ].slice(-300);
    current.updatedAt = Date.now();
    this.sessions.set(sessionId, current);
    this.emit();
  }

  appendRawResponse(sessionId: string, content: string): void {
    const current = this.sessions.get(sessionId);
    if (!current) {
      return;
    }
    current.rawResponses = [...current.rawResponses, content].slice(-20);
    current.updatedAt = Date.now();
    this.sessions.set(sessionId, current);
    this.emit();
  }

  appendChatMessage(
    sessionId: string,
    message: Omit<ChatMessage, 'id' | 'timestamp'>,
  ): ChatMessage | undefined {
    const current = this.sessions.get(sessionId);
    if (!current) {
      return undefined;
    }
    const entry: ChatMessage = {
      ...message,
      id: createId('msg'),
      timestamp: Date.now(),
    };
    current.chatHistory = [...current.chatHistory, entry].slice(-300);
    current.updatedAt = Date.now();
    this.sessions.set(sessionId, current);
    this.emit();
    return entry;
  }

  updateChatMessage(sessionId: string, messageId: string, patch: Partial<Omit<ChatMessage, 'id' | 'timestamp'>>): void {
    const current = this.sessions.get(sessionId);
    if (!current) {
      return;
    }
    current.chatHistory = current.chatHistory.map((entry) => (entry.id === messageId ? { ...entry, ...patch } : entry));
    current.updatedAt = Date.now();
    this.sessions.set(sessionId, current);
    this.emit();
  }

  pushAction(sessionId: string, action: SessionState['actionHistory'][number]): void {
    const current = this.sessions.get(sessionId);
    if (!current) {
      return;
    }
    current.actionHistory = [...current.actionHistory, action].slice(-150);
    current.updatedAt = Date.now();
    this.sessions.set(sessionId, current);
    this.emit();
  }

  updateAction(sessionId: string, actionId: string, patch: Partial<SessionState['actionHistory'][number]>): void {
    const current = this.sessions.get(sessionId);
    if (!current) {
      return;
    }
    current.actionHistory = current.actionHistory.map((action) =>
      action.id === actionId ? { ...action, ...patch } : action,
    );
    current.updatedAt = Date.now();
    this.sessions.set(sessionId, current);
    this.emit();
  }

  setStatus(sessionId: string, status: SessionStatus): void {
    this.update(sessionId, { status });
  }

  setProviderSessionId(sessionId: string, providerSessionId?: string): void {
    this.update(sessionId, { providerSessionId });
  }

  setApprovalRequest(sessionId: string, approvalRequest?: ApprovalRequest): void {
    const current = this.sessions.get(sessionId);
    if (!current) {
      return;
    }
    current.approvalRequest = approvalRequest;
    current.status = approvalRequest ? 'waiting-approval' : current.status === 'waiting-approval' ? 'running' : current.status;
    current.updatedAt = Date.now();
    this.sessions.set(sessionId, current);
    this.emit();
  }

  clear(): void {
    this.sessions.clear();
    this.activeSessionId = undefined;
    this.emit();
  }

  private emit(): void {
    void this.context.globalState.update(STORAGE_KEY, this.getAll());
    this.onDidChangeEmitter.fire();
  }
}
