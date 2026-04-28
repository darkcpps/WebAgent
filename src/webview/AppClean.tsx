import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../shared/messages';
import type { ImageAttachment, ProviderId, WebviewState } from '../shared/types';
import { sanitizeResponse } from '../shared/utils';

declare global {
  interface Window {
    acquireVsCodeApi: () => { postMessage: (message: WebviewToExtensionMessage) => void };
  }
}

const vscode = window.acquireVsCodeApi();
const LONG_RESPONSE_THRESHOLD_MS = 5 * 60 * 1000;
const MAX_IMAGE_ATTACHMENTS = 4;
const MAX_IMAGE_ATTACHMENT_BYTES = 8 * 1024 * 1024;


const defaultModels = [{ id: 'auto', label: 'Auto' }];

const initialState: WebviewState = {
  sessions: [],
  providers: ['chatgpt', 'gemini', 'perplexity'],
  providerModels: {
    chatgpt: defaultModels,
    gemini: defaultModels,
    perplexity: defaultModels,
  },
  modelRefreshStatus: {
    chatgpt: { status: 'idle' },
    gemini: { status: 'idle' },
    perplexity: { status: 'idle' },
  },
  providerReady: {
    chatgpt: false,
    gemini: false,
    perplexity: false,
  },
  approvalMode: 'ask-before-action',
};

export function App(): JSX.Element {
  const [state, setState] = useState<WebviewState>(initialState);
  const [providerId, setProviderId] = useState<ProviderId>('chatgpt');
  const [message, setMessage] = useState('');
  const [agentMode, setAgentMode] = useState(false);
  const [planningMode, setPlanningMode] = useState(false);
  const [showThinking, setShowThinking] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [expandedThinkingByMessage, setExpandedThinkingByMessage] = useState<Record<string, boolean>>({});
  const [modelByProvider, setModelByProvider] = useState<Record<string, string>>({});
  const [thinkingByProvider, setThinkingByProvider] = useState<Record<string, boolean>>({});
  const [toast, setToast] = useState<{ level: 'info' | 'warning' | 'error' | 'success'; message: string }>();
  const [debugOpen, setDebugOpen] = useState(true);
  const [sessionContextMenu, setSessionContextMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null);
  const [dismissedLongRunningBySession, setDismissedLongRunningBySession] = useState<Record<string, boolean>>({});
  const [now, setNow] = useState(Date.now());
  const hasPerformedStartupReadyCheck = useRef(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [imageAttachments, setImageAttachments] = useState<ImageAttachment[]>([]);

  useEffect(() => {
    const handler = (event: MessageEvent<ExtensionToWebviewMessage>) => {
      const payload = event.data;
      if (payload.type === 'state') {
        setState(payload.state);
        return;
      }
      if (payload.type === 'toast') {
        setToast({ level: payload.level, message: payload.message });
      }
    };

    window.addEventListener('message', handler);
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', handler);
  }, []);

  useEffect(() => {
    if (!state.providers.includes(providerId)) {
      setProviderId(state.providers[0] ?? 'chatgpt');
    }
  }, [providerId, state.providers]);

  useEffect(() => {
    vscode.postMessage({ type: 'checkProviderReady', providerId, silent: hasPerformedStartupReadyCheck.current });
    hasPerformedStartupReadyCheck.current = true;
  }, [providerId]);

  useEffect(() => {
    if (!toast) return;
    const timeoutId = window.setTimeout(() => setToast(undefined), 4000);
    return () => window.clearTimeout(timeoutId);
  }, [toast]);

  useEffect(() => {
    if (providerId !== 'chatgpt' && providerId !== 'perplexity') {
      setImageAttachments([]);
    }
  }, [providerId]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const closeMenu = () => setSessionContextMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => event.key === 'Escape' && setSessionContextMenu(null);
    window.addEventListener('click', closeMenu);
    window.addEventListener('scroll', closeMenu, true);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('click', closeMenu);
      window.removeEventListener('scroll', closeMenu, true);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, []);

  const providerModels = useMemo(() => state.providerModels[providerId] ?? defaultModels, [providerId, state.providerModels]);
  const selectedModelId = useMemo(() => {
    const current = modelByProvider[providerId];
    if (current && providerModels.some((model) => model.id === current)) return current;
    return providerModels[0]?.id ?? 'auto';
  }, [modelByProvider, providerId, providerModels]);

  useEffect(() => {
    if (!modelByProvider[providerId] && selectedModelId) {
      setModelByProvider((prev) => ({ ...prev, [providerId]: selectedModelId }));
    }
  }, [modelByProvider, providerId, selectedModelId]);

  const activeSession = useMemo(() => state.sessions.find((session) => session.id === state.activeSessionId) ?? state.sessions[0], [state.activeSessionId, state.sessions]);
  const isRunning = activeSession?.status === 'running';
  const isLoggedIn = state.providerReady[providerId];
  const supportsThinkingControl = providerId === 'perplexity';
  const hasExplicitThinkingPreference = Object.prototype.hasOwnProperty.call(thinkingByProvider, providerId);
  const enableThinking = Boolean(thinkingByProvider[providerId]);
  const canSend = message.trim().length > 0 && !isRunning && isLoggedIn;
  const canAttachImages = providerId === 'chatgpt' || providerId === 'perplexity';
  const debugLogs = activeSession?.logs ?? [];
  const autoApproveEnabled = state.approvalMode === 'auto-apply-safe-edits';
  const modifiedActionTypes = new Set(['edit_file', 'create_file', 'delete_file', 'rename_file']);
  const hasCompletedCodeChanges = Boolean(activeSession?.actionHistory.some((action) => action.status === 'done' && modifiedActionTypes.has(action.type)));
  const assistantMessages = activeSession?.chatHistory.filter((entry) => entry.role === 'assistant') ?? [];
  const latestAssistantMessage = assistantMessages.at(-1);
  const latestAssistantMessageId = latestAssistantMessage?.id;
  const latestUserBeforeAssistant = latestAssistantMessage
    ? activeSession?.chatHistory.slice(0, activeSession.chatHistory.findIndex((entry) => entry.id === latestAssistantMessage.id)).reverse().find((entry) => entry.role === 'user' && entry.content.trim().length > 0)
    : undefined;
  const showLongRunningPrompt = Boolean(activeSession && latestAssistantMessage && latestUserBeforeAssistant && activeSession.status === 'running' && now - latestAssistantMessage.timestamp >= LONG_RESPONSE_THRESHOLD_MS && !dismissedLongRunningBySession[activeSession.id]);
  const composerPlaceholder = planningMode ? 'Describe what you want planned, or add details to revise the current plan...' : agentMode ? 'Describe an agent task (files, goals, constraints)...' : 'Ask a question about your code, recent changes, or next steps...';

  const onNewChat = () => vscode.postMessage({ type: 'newChat', providerId });
  const onDeleteSession = (sessionId: string) => {
    setSessionContextMenu(null);
    vscode.postMessage({ type: 'deleteChat', sessionId });
  };
  const onOpenSessionContextMenu = (event: React.MouseEvent, sessionId: string) => {
    event.preventDefault();
    event.stopPropagation();
    setSessionContextMenu({ sessionId, x: Math.min(event.clientX, window.innerWidth - 158), y: Math.min(event.clientY, window.innerHeight - 54) });
  };
  const onSetAutoApprove = (enabled: boolean) => vscode.postMessage({ type: 'setApprovalMode', mode: enabled ? 'auto-apply-safe-edits' : 'ask-before-action' });
  const onPreviewChanges = () => activeSession && vscode.postMessage({ type: 'previewSessionChanges', sessionId: activeSession.id });

  const onSelectImages = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) return;

    const newAttachments: ImageAttachment[] = [...imageAttachments];
    for (const file of files) {
      if (newAttachments.length >= MAX_IMAGE_ATTACHMENTS) {
        setToast({ level: 'warning', message: `Maximum ${MAX_IMAGE_ATTACHMENTS} images allowed.` });
        break;
      }
      if (file.size > MAX_IMAGE_ATTACHMENT_BYTES) {
        setToast({ level: 'warning', message: `Image ${file.name} exceeds 8MB limit.` });
        continue;
      }

      const reader = new FileReader();
      const promise = new Promise<void>((resolve) => {
        reader.onload = () => {
          const base64 = (reader.result as string).split(',')[1];
          newAttachments.push({
            name: file.name,
            mimeType: file.type,
            data: base64,
          });
          resolve();
        };
      });
      reader.readAsDataURL(file);
      await promise;
    }

    setImageAttachments(newAttachments);
    if (imageInputRef.current) imageInputRef.current.value = '';
  };

  const removeImageAttachment = (name: string, index: number) => {
    setImageAttachments((prev) => prev.filter((a, i) => !(a.name === name && i === index)));
  };

  const sendMessage = (content: string, modelOverride?: string, modeOverride?: 'chat' | 'agent' | 'plan') => {
    if (!content) return;
    const targetSessionId = activeSession?.providerId === providerId ? activeSession.id : undefined;
    vscode.postMessage({
      type: 'sendChat',
      providerId,
      sessionId: targetSessionId,
      message: content,
      modelId: providerId === 'perplexity' ? 'auto' : modelOverride ?? selectedModelId,
      agentMode: modeOverride === 'agent' ? true : modeOverride === 'plan' ? false : agentMode,
      planningMode: modeOverride === 'plan' ? true : modeOverride === 'agent' ? false : planningMode,
      enableThinking: supportsThinkingControl && hasExplicitThinkingPreference ? enableThinking : undefined,
      imageAttachments: canAttachImages ? imageAttachments : undefined,
    });
  };

  const onSend = () => {
    const content = message.trim();
    if (!content) return;
    sendMessage(content);
    setMessage('');
    setImageAttachments([]);
  };
  const onImplementPlan = () => {
    if (!activeSession?.pendingPlan || isRunning || !isLoggedIn) return;
    setPlanningMode(false);
    setAgentMode(true);
    sendMessage('Implement this plan', undefined, 'agent');
  };
  const onRevisePlan = () => {
    if (!activeSession?.pendingPlan || isRunning) return;
    setPlanningMode(true);
    setAgentMode(false);
    window.requestAnimationFrame(() => composerRef.current?.focus());
  };
  const onRegenerateLongRunningInNewChat = () => {
    if (!activeSession || !latestUserBeforeAssistant || !isLoggedIn) return;
    setDismissedLongRunningBySession((prev) => ({ ...prev, [activeSession.id]: true }));
    vscode.postMessage({ type: 'regenerateChatInNewSession', providerId, sourceSessionId: activeSession.id, message: latestUserBeforeAssistant.content, modelId: providerId === 'perplexity' ? 'auto' : selectedModelId, agentMode, planningMode, enableThinking: supportsThinkingControl && hasExplicitThinkingPreference ? enableThinking : undefined });
  };

  return (
    <div className="chat-shell">
      <aside className="chat-sidebar">
        <div className="sidebar-header">
          <div className="hero-title">WebAgent Code</div>
          <button className="primary new-chat-btn" onClick={onNewChat}>+ New Chat</button>
        </div>

        <div className="card compact provider-card">
          <label className="field-label">Provider Setup</label>
          <select className="glass-select" value={providerId} onChange={(event) => setProviderId(event.target.value as ProviderId)}>
            {state.providers.map((provider) => <option key={provider} value={provider}>{provider.toUpperCase()}</option>)}
          </select>
          {providerId === 'perplexity' ? (
            <div className="model-browser-note">To select a Perplexity model, choose it in the Perplexity browser window opened by the IDE.</div>
          ) : (
            <select className="glass-select" value={selectedModelId} onChange={(event) => setModelByProvider((prev) => ({ ...prev, [providerId]: event.target.value }))}>
              {providerModels.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
            </select>
          )}
          <div className="button-row">
            {isLoggedIn ? <button className="auth-btn sign-out" onClick={() => vscode.postMessage({ type: 'logoutProvider', providerId })}>Sign Out</button> : <button className="auth-btn sign-in primary" onClick={() => vscode.postMessage({ type: 'loginProvider', providerId })}>Connect Provider</button>}
          </div>
          <button className="auth-btn mcp-view-btn" onClick={() => vscode.postMessage({ type: 'openMcpServersView' })}>MCP Servers</button>
        </div>

        <div className="session-list">
          <div className="list-title">Recent Chats</div>
          {state.sessions.map((session) => (
            <div key={session.id} className={`session-item ${session.id === activeSession?.id ? 'active' : ''}`} onContextMenu={(event) => onOpenSessionContextMenu(event, session.id)} title="Right-click to remove from IDE">
              <button className="session-open" onClick={() => vscode.postMessage({ type: 'setActiveSession', sessionId: session.id })}>
                <div className="session-top"><span className="session-provider">{session.providerId}</span><span className={`status-dot ${session.status}`} title={session.status}></span></div>
                <div className="session-task">{session.chatHistory.at(-1)?.content?.slice(0, 44) || 'Empty session...'}</div>
              </button>
            </div>
          ))}
        </div>
      </aside>

      <main className="chat-main">
        {toast ? <div className={`toast-banner ${toast.level}`}>{toast.message}</div> : null}
        <header className="chat-header">
          <div className="header-tabs"><button className="tab-btn active">Chat</button></div>
          <div className="header-actions">
            <button
              className={`settings-toggle ${autoApproveEnabled ? 'auto-on' : ''}`}
              title="Workflow settings"
              onClick={() => setSettingsOpen((value) => !value)}
            >
              <span className="settings-gear">⚙</span>
              <span>Settings</span>
              {autoApproveEnabled ? <span className="settings-pill">Auto approve</span> : null}
            </button>
            <button className="debug-toggle" onClick={() => setDebugOpen((value) => !value)}>{debugOpen ? 'Hide Logs' : 'View Logs'}</button>
          </div>
        </header>

        <section className="chat-scroll">
          {settingsOpen ? (
            <div className="settings-panel">
              <div>
                <div className="settings-title">Workflow Settings</div>
                <div className="settings-help">Safe edits can run without manual approval. Higher risk actions still use the safety policy.</div>
              </div>
              <label className="toggle-switch">
                <input type="checkbox" checked={autoApproveEnabled} onChange={(event) => onSetAutoApprove(event.target.checked)} />
                <span className="slider"></span>
                <span className="toggle-label">Auto Approve</span>
              </label>
            </div>
          ) : null}

          {activeSession?.chatHistory.length ? activeSession.chatHistory.map((entry, index) => {
            const thoughtView = getThoughtView(entry.rawContent, entry.content);
            const thinkingExpanded = Boolean(expandedThinkingByMessage[entry.id]) || showThinking;
            const rawContentToRender = entry.role === 'assistant' && thoughtView.answer.trim().length > 0 ? thoughtView.answer : entry.content;
            const contentToRender = entry.role === 'assistant' ? sanitizeResponse(rawContentToRender) || rawContentToRender : rawContentToRender;
            return (
              <article key={entry.id} className={`chat-bubble ${entry.role}`}>
                <div className="bubble-avatar">{entry.role === 'user' ? 'U' : 'AI'}</div>
                <div className="bubble-content-wrap">
                  {entry.role === 'assistant' && (thoughtView.hasThinking || thoughtView.live) && (
                    <details className="thinking-details" open={thinkingExpanded} onToggle={(e) => setExpandedThinkingByMessage((prev) => ({ ...prev, [entry.id]: (e.target as HTMLDetailsElement).open }))}>
                      <summary className="thinking-summary"><span className="thinking-icon">✧</span><span className="thinking-title">{thoughtView.live ? 'Analyzing workspace...' : 'View thought process'}</span></summary>
                      <div className="thinking-content-inner">{thoughtView.thinking || (thoughtView.live ? 'Working...' : '')}</div>
                    </details>
                  )}
                  {contentToRender && (!thoughtView.live || contentToRender !== 'Thinking...') ? <div className="chat-content"><MarkdownContent content={contentToRender} /></div> : null}
                  {entry.role === 'assistant' && !isRunning && activeSession?.pendingPlan && latestAssistantMessageId === entry.id && entry.content === activeSession.pendingPlan.plan ? <div className="response-actions"><button className="glass-btn primary" onClick={onImplementPlan} disabled={!isLoggedIn}>Implement Plan</button><button className="glass-btn" onClick={onRevisePlan}>Revise Plan</button></div> : null}
                  {entry.role === 'assistant' && !isRunning && hasCompletedCodeChanges && latestAssistantMessageId === entry.id ? <div className="response-actions"><button className="glass-btn preview-changes-btn" onClick={onPreviewChanges}>Preview</button></div> : null}
                </div>
              </article>
            );
          }) : <div className="empty-state"><div className="empty-icon">✧</div><h3>Ready to assist</h3><p>Send a message below or start an agentic task to begin.</p></div>}

          {activeSession?.approvalRequest ? (
            <div className="approval-card">
              <div className="approval-header"><strong>Action Required</strong><span className="action-type">{activeSession.approvalRequest.type}</span></div>
              <div className="approval-summary">{activeSession.approvalRequest.summary}</div>
              {activeSession.approvalRequest.preview ? <pre className="approval-preview">{activeSession.approvalRequest.preview}</pre> : null}
              <div className="approval-buttons"><button className="primary approve-btn" onClick={() => vscode.postMessage({ type: 'approve', sessionId: activeSession.id, actionId: activeSession.approvalRequest!.actionId })}>Approve</button><button className="secondary reject-btn" onClick={() => vscode.postMessage({ type: 'reject', sessionId: activeSession.id, actionId: activeSession.approvalRequest!.actionId })}>Reject</button></div>
            </div>
          ) : null}

          {showLongRunningPrompt ? <div className="long-running-card"><div><strong>This response is taking longer than 5 minutes.</strong><p>You can keep waiting, or retry the same prompt in a fresh chat.</p></div><div className="long-running-actions"><button className="glass-btn" onClick={() => activeSession && setDismissedLongRunningBySession((prev) => ({ ...prev, [activeSession.id]: true }))}>Keep Waiting</button><button className="glass-btn primary" onClick={onRegenerateLongRunningInNewChat} disabled={!isLoggedIn}>Regenerate in New Chat</button></div></div> : null}
        </section>

        <footer className="chat-composer">
          {imageAttachments.length > 0 ? (
            <div className="attachment-tray">
              {imageAttachments.map((attachment, index) => (
                <button
                  key={`${attachment.name}-${index}`}
                  className="attachment-chip"
                  title="Remove image"
                  onClick={() => removeImageAttachment(attachment.name, index)}
                >
                  <span>{attachment.name}</span>
                  <span aria-hidden="true">x</span>
                </button>
              ))}
            </div>
          ) : null}
          <div className="composer-input-area">
            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden-file-input"
              onChange={onSelectImages}
            />
            <button
              className="attach-btn"
              disabled={!canAttachImages || isRunning || !isLoggedIn}
              title={canAttachImages ? 'Attach image' : 'Images are supported for ChatGPT and Perplexity'}
              onClick={() => imageInputRef.current?.click()}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05 12 20.49a6 6 0 0 1-8.49-8.49l9.44-9.44a4 4 0 1 1 5.66 5.66l-9.45 9.44a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg>
            </button>
            <textarea ref={composerRef} rows={1} placeholder={composerPlaceholder} value={message} onChange={(event) => { event.target.style.height = 'auto'; event.target.style.height = `${Math.min(event.target.scrollHeight, 200)}px`; setMessage(event.target.value); }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); onSend(); event.currentTarget.style.height = 'auto'; } }} />
            <button className="primary send-btn" disabled={!canSend} onClick={onSend}>➤</button>
          </div>
          <div className="composer-toolbar">
            <label className="toggle-switch"><input type="checkbox" checked={agentMode} onChange={(event) => { setAgentMode(event.target.checked); if (event.target.checked) setPlanningMode(false); }} /><span className="slider"></span><span className="toggle-label">Agent Mode</span></label>
            <label className="toggle-switch"><input type="checkbox" checked={planningMode} onChange={(event) => { setPlanningMode(event.target.checked); if (event.target.checked) setAgentMode(false); }} /><span className="slider"></span><span className="toggle-label">Planning Mode</span></label>
            <label className="toggle-switch"><input type="checkbox" checked={enableThinking} disabled={!supportsThinkingControl} onChange={(event) => setThinkingByProvider((prev) => ({ ...prev, [providerId]: event.target.checked }))} /><span className="slider"></span><span className="toggle-label">Enable Model Thinking</span></label>
            <label className="toggle-switch"><input type="checkbox" checked={showThinking} onChange={(event) => setShowThinking(event.target.checked)} /><span className="slider"></span><span className="toggle-label">Auto-expand Thoughts</span></label>
            {!supportsThinkingControl && <div className="auth-warning">Model thinking toggle is currently supported for Perplexity.</div>}
            {!isLoggedIn && <div className="auth-warning">Sign in before sending.</div>}
          </div>
        </footer>

        {debugOpen && <section className="debug-console"><div className="debug-title">System Logs</div><div className="debug-list">{debugLogs.length ? debugLogs.slice(-150).map((log) => <div key={log.id} className={`debug-line ${log.level}`}><span className="debug-time">{new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span><span className="debug-source">[{log.source}]</span><span className="debug-message">{log.message}</span></div>) : <div className="debug-empty">Standing by...</div>}</div></section>}
        {sessionContextMenu ? <div className="session-context-menu" style={{ left: sessionContextMenu.x, top: sessionContextMenu.y }} onClick={(event) => event.stopPropagation()}><button onClick={() => onDeleteSession(sessionContextMenu.sessionId)}>Remove</button></div> : null}
      </main>
    </div>
  );
}

interface ThoughtView { answer: string; thinking: string; hasThinking: boolean; live: boolean; }

function getThoughtView(rawContent: string | undefined, fallbackAnswer: string): ThoughtView {
  const raw = (rawContent || '').trim();
  if (!raw) return { answer: fallbackAnswer, thinking: '', hasThinking: false, live: /thinking\.\.\./i.test(fallbackAnswer) };
  const thinkMatch = raw.match(/<think>([\s\S]*?)(?:<\/think>|$)/i);
  const thinking = thinkMatch?.[1]?.trim() ?? '';
  const answer = raw.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim();
  return { answer: answer || fallbackAnswer, thinking, hasThinking: Boolean(thinking), live: /thinking\.\.\./i.test(fallbackAnswer) && !answer };
}

function renderInlineMarkdown(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const tokenRegex = /(`[^`]+`|\*\*\*[^*]+?\*\*\*|\*\*[^*]+?\*\*|\*[^*]+?\*|__[^_]+?__|_[^_]+?_)/g;
  let lastIndex = 0;
  let tokenIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(text)) !== null) {
    const plain = text.slice(lastIndex, match.index);
    if (plain) {
      nodes.push(<React.Fragment key={`${keyPrefix}-plain-${tokenIndex}`}>{plain}</React.Fragment>);
    }

    const token = match[0];
    const delimiterLength = token.startsWith('`')
      ? 1
      : token.startsWith('***') || token.startsWith('___')
        ? 3
        : token.startsWith('**') || token.startsWith('__')
          ? 2
          : 1;
    const inner = token.slice(delimiterLength, -delimiterLength);
    if (token.startsWith('`')) {
      nodes.push(
        <code key={`${keyPrefix}-code-${tokenIndex}`} className="md-inline-code">
          {inner}
        </code>,
      );
    } else if (token.startsWith('***') || token.startsWith('___')) {
      nodes.push(
        <strong key={`${keyPrefix}-strong-${tokenIndex}`}>
          <em>{inner}</em>
        </strong>,
      );
    } else if (token.startsWith('**') || token.startsWith('__')) {
      nodes.push(<strong key={`${keyPrefix}-strong-${tokenIndex}`}>{inner}</strong>);
    } else {
      nodes.push(<em key={`${keyPrefix}-em-${tokenIndex}`}>{inner}</em>);
    }

    lastIndex = tokenRegex.lastIndex;
    tokenIndex += 1;
  }

  const suffix = text.slice(lastIndex);
  if (suffix) {
    nodes.push(<React.Fragment key={`${keyPrefix}-suffix`}>{suffix}</React.Fragment>);
  }

  return nodes;
}

function renderTextBlock(text: string, blockIndex: number): React.ReactNode[] {
  const lines = text.split(/\r?\n/);
  const nodes: React.ReactNode[] = [];
  let i = 0;
  let nodeIndex = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      i += 1;
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = Math.min(headingMatch[1].length, 6);
      const textValue = headingMatch[2].trim();
      const className = `md-heading md-h${level}`;
      const key = `md-${blockIndex}-heading-${nodeIndex}`;
      const headingContent = renderInlineMarkdown(textValue, key);
      if (level === 1) nodes.push(<h1 key={key} className={className}>{headingContent}</h1>);
      else if (level === 2) nodes.push(<h2 key={key} className={className}>{headingContent}</h2>);
      else if (level === 3) nodes.push(<h3 key={key} className={className}>{headingContent}</h3>);
      else if (level === 4) nodes.push(<h4 key={key} className={className}>{headingContent}</h4>);
      else if (level === 5) nodes.push(<h5 key={key} className={className}>{headingContent}</h5>);
      else nodes.push(<h6 key={key} className={className}>{headingContent}</h6>);
      i += 1;
      nodeIndex += 1;
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, '').trim());
        i += 1;
      }
      const key = `md-${blockIndex}-ul-${nodeIndex}`;
      nodes.push(
        <ul key={key} className="md-list">
          {items.map((item, itemIndex) => (
            <li key={`${key}-li-${itemIndex}`}>{renderInlineMarkdown(item, `${key}-li-${itemIndex}`)}</li>
          ))}
        </ul>,
      );
      nodeIndex += 1;
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, '').trim());
        i += 1;
      }
      const key = `md-${blockIndex}-ol-${nodeIndex}`;
      nodes.push(
        <ol key={key} className="md-list md-list-ordered">
          {items.map((item, itemIndex) => (
            <li key={`${key}-li-${itemIndex}`}>{renderInlineMarkdown(item, `${key}-li-${itemIndex}`)}</li>
          ))}
        </ol>,
      );
      nodeIndex += 1;
      continue;
    }

    const paragraph: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6})\s+/.test(lines[i].trim()) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      paragraph.push(lines[i].trim());
      i += 1;
    }
    const paragraphText = paragraph.join(' ');
    const key = `md-${blockIndex}-p-${nodeIndex}`;
    nodes.push(
      <p key={key} className="md-paragraph">
        {renderInlineMarkdown(paragraphText, key)}
      </p>,
    );
    nodeIndex += 1;
  }

  return nodes;
}

function MarkdownContent({ content }: { content: string }): JSX.Element {
  const blocks: Array<{ type: 'text' | 'code'; text: string; lang?: string }> = [];
  const regex = /```([a-zA-Z0-9_-]+)?\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    const prefix = content.slice(lastIndex, match.index);
    if (prefix.trim().length > 0) {
      blocks.push({ type: 'text', text: prefix.trim() });
    }

    blocks.push({
      type: 'code',
      lang: match[1] || '',
      text: (match[2] || '').replace(/\n$/, ''),
    });

    lastIndex = regex.lastIndex;
  }

  const suffix = content.slice(lastIndex);
  if (suffix.trim().length > 0 || blocks.length === 0) {
    blocks.push({ type: 'text', text: suffix.trim() || content });
  }

  return (
    <>
      {blocks.map((block, index) =>
        block.type === 'code' ? (
          <pre key={`code-${index}`} className="md-code">
            {block.lang ? <div className="md-code-lang">{block.lang}</div> : null}
            <code>{block.text}</code>
          </pre>
        ) : (
          <div key={`text-${index}`} className="md-text">{renderTextBlock(block.text, index)}</div>
        ),
      )}
    </>
  );
}
