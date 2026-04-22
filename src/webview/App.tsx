import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../shared/messages';
import type { WebviewState } from '../shared/types';

declare global {
  interface Window {
    acquireVsCodeApi: () => { postMessage: (message: WebviewToExtensionMessage) => void };
  }
}

const vscode = window.acquireVsCodeApi();

const initialState: WebviewState = {
  sessions: [],
  providers: ['chatgpt', 'gemini', 'zai'],
  providerModels: {
    chatgpt: [{ id: 'auto', label: 'Auto' }],
    gemini: [{ id: 'auto', label: 'Auto' }],
    zai: [{ id: 'auto', label: 'Auto' }],
  },
  providerReady: {
    chatgpt: false,
    gemini: false,
    zai: false,
  },
  approvalMode: 'ask-before-action',
  bridge: {
    transport: 'bridge',
    autoStartCompanion: true,
    companionReachable: false,
    companionOwnedByExtension: false,
    browserConnected: false,
    ready: false,
    loginRequired: false,
  },
};

export function App(): JSX.Element {
  const [state, setState] = useState<WebviewState>(initialState);
  const [providerId, setProviderId] = useState<WebviewState['providers'][number]>('zai');
  const [message, setMessage] = useState('');
  const [agentMode, setAgentMode] = useState(false);
  const [showThinking, setShowThinking] = useState(false);
  const [activeTab, setActiveTab] = useState<'chat' | 'bridge' | 'settings'>('chat');
  const [expandedThinkingByMessage, setExpandedThinkingByMessage] = useState<Record<string, boolean>>({});
  const [modelByProvider, setModelByProvider] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<{ level: 'info' | 'warning' | 'error' | 'success'; message: string }>();
  const [debugOpen, setDebugOpen] = useState(true);
  const [sessionContextMenu, setSessionContextMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null);
  const hasPerformedStartupReadyCheck = useRef(false);

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
      setProviderId(state.providers[0] ?? 'zai');
    }
  }, [providerId, state.providers]);

  useEffect(() => {
    vscode.postMessage({
      type: 'checkProviderReady',
      providerId,
      silent: hasPerformedStartupReadyCheck.current,
    });
    hasPerformedStartupReadyCheck.current = true;
    return undefined;
  }, [providerId]);

  useEffect(() => {
    if (providerId !== 'zai') {
      return undefined;
    }

    vscode.postMessage({ type: 'refreshBridgeStatus' });
    const timer = window.setInterval(() => {
      vscode.postMessage({ type: 'refreshBridgeStatus' });
    }, 2500);

    return () => window.clearInterval(timer);
  }, [providerId]);

  useEffect(() => {
    if (!toast) {
      return;
    }
    const timeoutId = window.setTimeout(() => setToast(undefined), 4000);
    return () => window.clearTimeout(timeoutId);
  }, [toast]);

  useEffect(() => {
    const closeMenu = () => setSessionContextMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSessionContextMenu(null);
      }
    };

    window.addEventListener('click', closeMenu);
    window.addEventListener('scroll', closeMenu, true);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('click', closeMenu);
      window.removeEventListener('scroll', closeMenu, true);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, []);

  const providerModels = useMemo(
    () => state.providerModels[providerId] ?? [{ id: 'auto', label: 'Auto' }],
    [providerId, state.providerModels],
  );

  const selectedModelId = useMemo(() => {
    const current = modelByProvider[providerId];
    if (current && providerModels.some((model) => model.id === current)) {
      return current;
    }
    return providerModels[0]?.id ?? 'auto';
  }, [modelByProvider, providerId, providerModels]);

  useEffect(() => {
    if (!modelByProvider[providerId] && selectedModelId) {
      setModelByProvider((prev) => ({ ...prev, [providerId]: selectedModelId }));
    }
  }, [modelByProvider, providerId, selectedModelId]);

  const activeSession = useMemo(
    () => state.sessions.find((session) => session.id === state.activeSessionId) ?? state.sessions[0],
    [state.activeSessionId, state.sessions],
  );

  const isRunning = activeSession?.status === 'running';
  const isBridgeMode = providerId === 'zai' && state.bridge.transport === 'bridge';
  const isLoggedIn = isBridgeMode ? state.bridge.ready : state.providerReady[providerId];
  const canSend = message.trim().length > 0 && !isRunning && isLoggedIn;
  const debugLogs = activeSession?.logs ?? [];
  const autoApproveEnabled = state.approvalMode === 'auto-apply-safe-edits';
  const modifiedActionTypes = new Set(['edit_file', 'create_file', 'delete_file', 'rename_file']);
  const hasCompletedCodeChanges = Boolean(
    activeSession?.actionHistory.some((action) => action.status === 'done' && modifiedActionTypes.has(action.type)),
  );
  const latestAssistantMessageId =
    activeSession?.chatHistory
      .filter((entry) => entry.role === 'assistant')
      .at(-1)?.id ?? undefined;
  const composerPlaceholder = agentMode
    ? 'Describe an agent task (files, goals, constraints)...'
    : 'Ask a question about your code, recent changes, or next steps...';

  const onNewChat = () => {
    vscode.postMessage({ type: 'newChat', providerId });
  };

  const onDeleteSession = (sessionId: string) => {
    setSessionContextMenu(null);
    vscode.postMessage({ type: 'deleteChat', sessionId });
  };

  const onOpenSessionContextMenu = (event: React.MouseEvent, sessionId: string) => {
    event.preventDefault();
    event.stopPropagation();
    const menuWidth = 150;
    const menuHeight = 46;
    const x = Math.min(event.clientX, window.innerWidth - menuWidth - 8);
    const y = Math.min(event.clientY, window.innerHeight - menuHeight - 8);
    setSessionContextMenu({ sessionId, x: Math.max(8, x), y: Math.max(8, y) });
  };

  const onSetAutoApprove = (enabled: boolean) => {
    vscode.postMessage({
      type: 'setApprovalMode',
      mode: enabled ? 'auto-apply-safe-edits' : 'ask-before-action',
    });
  };

  const onPreviewChanges = () => {
    if (!activeSession) {
      return;
    }
    vscode.postMessage({ type: 'previewSessionChanges', sessionId: activeSession.id });
  };

  const sendMessage = (content: string, modelOverride?: string) => {
    if (!content) {
      return;
    }
    const targetSessionId = activeSession?.providerId === providerId ? activeSession.id : undefined;
    vscode.postMessage({
      type: 'sendChat',
      providerId,
      sessionId: targetSessionId,
      message: content,
      modelId: modelOverride ?? selectedModelId,
      agentMode,
    });
  };

  const onSend = () => {
    const content = message.trim();
    if (!content) {
      return;
    }
    sendMessage(content);
    setMessage('');
  };

  const isCapacityMessage = (content: string): boolean => /model is currently at capacity/i.test(content);

  const onRegenerate = (assistantIndex: number, switchToTurbo: boolean) => {
    if (!activeSession || isRunning || !isLoggedIn) {
      return;
    }

    const previousMessages = activeSession.chatHistory.slice(0, assistantIndex).reverse();
    const previousUserMessage = previousMessages.find((entry) => entry.role === 'user' && entry.content.trim().length > 0);
    if (!previousUserMessage) {
      return;
    }

    let modelOverride = selectedModelId;
    if (switchToTurbo) {
      const turbo = providerModels.find((model) => /glm-?5-?turbo/i.test(model.id) || /glm-?5-?turbo/i.test(model.label));
      if (turbo) {
        setModelByProvider((prev) => ({ ...prev, [providerId]: turbo.id }));
        modelOverride = turbo.id;
      }
    }

    sendMessage(previousUserMessage.content, modelOverride);
  };

  const toggleThoughtDetails = (messageId: string) => {
    setExpandedThinkingByMessage((prev) => ({
      ...prev,
      [messageId]: !prev[messageId],
    }));
  };

  return (
    <div className="chat-shell">
      <aside className="chat-sidebar">
        <div className="sidebar-header">
          <div className="hero-title">Z.ai Dev</div>
          <button className="primary new-chat-btn" onClick={onNewChat}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
            New Chat
          </button>
        </div>

        <div className="card compact provider-card">
          <label className="field-label">Provider Setup</label>
          <select className="glass-select" value={providerId} onChange={(event) => setProviderId(event.target.value as typeof providerId)}>
            {state.providers.map((provider) => (
              <option key={provider} value={provider}>
                {provider.toUpperCase()}
              </option>
            ))}
          </select>
          <select
            className="glass-select"
            value={selectedModelId}
            onChange={(event) =>
              setModelByProvider((prev) => ({
                ...prev,
                [providerId]: event.target.value,
              }))
            }
          >
            {providerModels.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
          <div className="button-row">
            {isLoggedIn ? (
              <button className="auth-btn sign-out" onClick={() => vscode.postMessage({ type: 'logoutProvider', providerId })}>Sign Out</button>
            ) : (
              <button className="auth-btn sign-in primary" onClick={() => vscode.postMessage({ type: 'loginProvider', providerId })}>Connect Provider</button>
            )}
          </div>
        </div>

        <div className="session-list">
          <div className="list-title">Recent Chats</div>
          {state.sessions.map((session) => (
            <div
              key={session.id}
              className={`session-item ${session.id === activeSession?.id ? 'active' : ''}`}
              onContextMenu={(event) => onOpenSessionContextMenu(event, session.id)}
              title="Right-click to remove from IDE"
            >
              <button className="session-open" onClick={() => vscode.postMessage({ type: 'setActiveSession', sessionId: session.id })}>
                <div className="session-top">
                  <span className="session-provider">{session.providerId}</span>
                  <span className={`status-dot ${session.status}`} title={session.status}></span>
                </div>
                <div className="session-task">{session.chatHistory.at(-1)?.content?.slice(0, 44) || 'Empty session...'}</div>
              </button>
            </div>
          ))}
        </div>
      </aside>

      <main className="chat-main">
        {toast ? <div className={`toast-banner ${toast.level}`}>{toast.message}</div> : null}

        <header className="chat-header">
          <div className="header-tabs">
            <button className={activeTab === 'chat' ? 'tab-btn active' : 'tab-btn'} onClick={() => setActiveTab('chat')}>
               Chat
            </button>
            <button className={activeTab === 'bridge' ? 'tab-btn active' : 'tab-btn'} onClick={() => setActiveTab('bridge')}>
               Bridge Settings
            </button>
            <button className={activeTab === 'settings' ? 'tab-btn active' : 'tab-btn'} onClick={() => setActiveTab('settings')}>
               Settings
            </button>
          </div>
          <button className="debug-toggle" onClick={() => setDebugOpen((value) => !value)}>
            {debugOpen ? 'Hide Logs' : 'View Logs'}
          </button>
        </header>

        {activeTab === 'chat' ? (
          <>
            <section className="chat-scroll">
              {activeSession?.chatHistory.length ? (
                activeSession.chatHistory.map((entry, index) => {
                  const thoughtView = getThoughtView(entry.rawContent, entry.content);
                  const thinkingExpanded = Boolean(expandedThinkingByMessage[entry.id]) || showThinking;
                  const contentToRender =
                    entry.role === 'assistant' && thoughtView.answer.trim().length > 0 ? thoughtView.answer : entry.content;

                  return (
                    <article key={entry.id} className={`chat-bubble ${entry.role}`}>
                      <div className="bubble-avatar">
                        {entry.role === 'user' ? 'U' : 'AI'}
                      </div>
                      <div className="bubble-content-wrap">
                        {entry.role === 'assistant' && (thoughtView.hasThinking || thoughtView.live) && (
                          <details 
                            className="thinking-details"
                            open={thinkingExpanded}
                            onToggle={(e) => {
                               const isOpen = (e.target as HTMLDetailsElement).open;
                               setExpandedThinkingByMessage(prev => ({...prev, [entry.id]: isOpen}));
                            }}
                          >
                            <summary className="thinking-summary">
                              <span className="thinking-icon">✧</span>
                              <span className="thinking-title">{thoughtView.live ? 'Analyzing workspace...' : 'View thought process'}</span>
                            </summary>
                            <div className="thinking-content-inner">
                              {thoughtView.thinking || (thoughtView.live ? 'Working...' : '')}
                            </div>
                          </details>
                        )}
                        {contentToRender && (!thoughtView.live || contentToRender !== 'Thinking...') ? (
                          <div className="chat-content">
                            <MarkdownContent content={contentToRender} />
                          </div>
                        ) : null}
                        
                        {entry.role === 'assistant' && isCapacityMessage(entry.content) ? (
                          <div className="capacity-actions">
                            <button className="glass-btn" onClick={() => onRegenerate(index, false)} disabled={isRunning || !isLoggedIn}>
                              Retry Query
                            </button>
                            <button className="glass-btn primary" onClick={() => onRegenerate(index, true)} disabled={isRunning || !isLoggedIn}>
                              Use GLM-5-Turbo
                            </button>
                          </div>
                        ) : null}
                        {entry.role === 'assistant' &&
                        !isRunning &&
                        hasCompletedCodeChanges &&
                        latestAssistantMessageId === entry.id ? (
                          <div className="response-actions">
                            <button className="glass-btn preview-changes-btn" onClick={onPreviewChanges}>
                              Preview
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </article>
                  );
                })
              ) : (
                <div className="empty-state">
                  <div className="empty-icon">✧</div>
                  <h3>Ready to assist</h3>
                  <p>Send a message below or start an agentic task to begin.</p>
                </div>
              )}
              
              {activeSession?.approvalRequest ? (
                <div className="approval-card">
                  <div className="approval-header">
                    <strong>Action Required</strong>
                    <span className="action-type">{activeSession.approvalRequest.type}</span>
                  </div>
                  <div className="approval-summary">{activeSession.approvalRequest.summary}</div>
                  {activeSession.approvalRequest.preview ? (
                    <pre className="approval-preview">{activeSession.approvalRequest.preview}</pre>
                  ) : null}
                  <div className="approval-buttons">
                    <button
                      className="primary approve-btn"
                      onClick={() =>
                        vscode.postMessage({ type: 'approve', sessionId: activeSession.id, actionId: activeSession.approvalRequest!.actionId })
                      }
                    >
                      Approve
                    </button>
                    <button
                      className="secondary reject-btn"
                      onClick={() =>
                        vscode.postMessage({ type: 'reject', sessionId: activeSession.id, actionId: activeSession.approvalRequest!.actionId })
                      }
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ) : null}
            </section>

            <footer className="chat-composer">
               <div className="composer-input-area">
                 <textarea
                   rows={1}
                    placeholder={composerPlaceholder}
                    value={message}
                   onChange={(event) => {
                     event.target.style.height = 'auto';
                     event.target.style.height = (event.target.scrollHeight < 200 ? event.target.scrollHeight : 200) + 'px';
                     setMessage(event.target.value);
                   }}
                   onKeyDown={(event) => {
                     if (event.key === 'Enter' && !event.shiftKey) {
                       event.preventDefault();
                       onSend();
                       event.currentTarget.style.height = 'auto';
                     }
                   }}
                 />
                 <button className="primary send-btn" disabled={!canSend} onClick={() => { onSend(); }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
                  </button>
               </div>

               <div className="composer-toolbar">
                <label className="toggle-switch">
                  <input type="checkbox" checked={agentMode} onChange={(e) => setAgentMode(e.target.checked)} />
                  <span className="slider"></span>
                  <span className="toggle-label">Agent Mode</span>
                </label>
                
                <label className="toggle-switch">
                  <input type="checkbox" checked={showThinking} onChange={(e) => setShowThinking(e.target.checked)} />
                  <span className="slider"></span>
                  <span className="toggle-label">Auto-expand Thoughts</span>
                </label>

                {!isLoggedIn && (
                  <div className="auth-warning">
                    {isBridgeMode
                      ? state.bridge.companionReachable
                        ? state.bridge.browserConnected
                          ? `Sign in before sending messages.`
                          : 'Load browser extension to connect.'
                        : 'Bridge companion offline.'
                      : `Sign in before sending.`}
                  </div>
                )}
              </div>
            </footer>
          </>
        ) : activeTab === 'bridge' ? (
          <section className="bridge-tab">
            {providerId !== 'zai' ? (
              <div className="empty-state">Select provider `zai` to view bridge tools.</div>
            ) : (
              <div className="card bridge-tab-card glass-panel">
                <div className="bridge-title">Bridge Configuration</div>
                <div className="bridge-row">
                  <span>Transport</span>
                  <strong>{state.bridge.transport}</strong>
                </div>
                <div className="bridge-row">
                  <span>Local Server</span>
                  <span className={`bridge-pill ${state.bridge.companionReachable ? 'ok' : 'bad'}`}>
                    {state.bridge.companionReachable ? 'Running' : 'Offline'}
                  </span>
                </div>
                <div className="bridge-row">
                  <span>Browser Link</span>
                  <span className={`bridge-pill ${state.bridge.browserConnected ? 'ok' : 'bad'}`}>
                    {state.bridge.browserConnected ? 'Active' : 'Inactive'}
                  </span>
                </div>
                <div className="bridge-row">
                  <span>Provider Ready</span>
                  <span className={`bridge-pill ${state.bridge.ready ? 'ok' : 'warn'}`}>
                    {state.bridge.ready ? 'Yes' : 'No'}
                  </span>
                </div>
                <hr className="divider" />
                <div className="bridge-buttons">
                  <button className="glass-btn primary" onClick={() => vscode.postMessage({ type: 'startBridgeCompanion' })}>Start Server</button>
                  <button className="glass-btn" onClick={() => vscode.postMessage({ type: 'restartBridgeCompanion' })}>Restart</button>
                  <button className="glass-btn danger" onClick={() => vscode.postMessage({ type: 'stopBridgeCompanion' })}>Kill</button>
                </div>
                <div className="bridge-buttons ext-buttons">
                  <button className="glass-btn" onClick={() => vscode.postMessage({ type: 'openZaiInBrowser' })}>Open Z.ai</button>
                  <button className="glass-btn" onClick={() => vscode.postMessage({ type: 'openBridgeExtensionFolder' })}>Reveal Extension</button>
                </div>
                {state.bridge.lastError && (
                  <div className="bridge-error">{state.bridge.lastError}</div>
                )}
              </div>
            )}
          </section>
        ) : (
          <section className="settings-tab">
            <div className="card settings-card glass-panel">
              <div className="settings-title">Workflow Settings</div>
              <div className="settings-row">
                <div>
                  <div className="settings-label">Auto Approve</div>
                  <div className="settings-help">When enabled, safe edits run without manual Approve clicks.</div>
                </div>
                <label className="toggle-switch">
                  <input type="checkbox" checked={autoApproveEnabled} onChange={(e) => onSetAutoApprove(e.target.checked)} />
                  <span className="slider"></span>
                </label>
              </div>
              <div className="settings-note">
                Sensitive paths and dangerous commands are still protected by safety rules.
              </div>
            </div>
          </section>
        )}

        {debugOpen && (
          <section className="debug-console">
            <div className="debug-title">System Logs</div>
            <div className="debug-list">
              {debugLogs.length ? (
                debugLogs.slice(-150).map((log) => (
                  <div key={log.id} className={`debug-line ${log.level}`}>
                    <span className="debug-time">{new Date(log.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'})}</span>
                    <span className="debug-source">[{log.source}]</span>
                    <span className="debug-message">{log.message}</span>
                  </div>
                ))
              ) : (
                <div className="debug-empty">Standing by...</div>
              )}
            </div>
          </section>
        )}
        {sessionContextMenu ? (
          <div
            className="session-context-menu"
            style={{ left: sessionContextMenu.x, top: sessionContextMenu.y }}
            onClick={(event) => event.stopPropagation()}
          >
            <button onClick={() => onDeleteSession(sessionContextMenu.sessionId)}>Remove</button>
          </div>
        ) : null}
      </main>
    </div>
  );
}

interface ThoughtView {
  answer: string;
  thinking: string;
  hasThinking: boolean;
  live: boolean;
}

function getThoughtView(rawContent: string | undefined, fallbackAnswer: string): ThoughtView {
  const raw = (rawContent || '').trim();
  if (!raw) {
    return {
      answer: fallbackAnswer,
      thinking: '',
      hasThinking: false,
      live: /thinking\.\.\./i.test(fallbackAnswer),
    };
  }

  let working = raw;
  const thinkingParts: string[] = [];

  const taggedThinkRegex = /<(think|thought|reasoning|analysis)>([\s\S]*?)(?:<\/\1>|$)/gi;
  working = working.replace(taggedThinkRegex, (_whole, _tag: string, content: string) => {
    if (content.trim()) {
      thinkingParts.push(content.trim());
    }
    return '';
  });

  const headingThinkRegex =
    /(?:^|\n)(?:#{1,3}\s*)?(?:thinking|thought process|reasoning|analysis)\s*:?\s*([\s\S]*?)(?=\n(?:#{1,3}\s*)?(?:final answer|answer|response|result)\s*:|$)/gi;
  working = working.replace(headingThinkRegex, (_whole, content: string) => {
    if (content.trim()) {
      thinkingParts.push(content.trim());
    }
    return '';
  });

  const answer = fallbackAnswer || working.trim();
  let thinking = thinkingParts.join('\n\n').trim();
  const live = /thinking\.\.\./i.test(fallbackAnswer) || /<(think|thought|reasoning|analysis)>/i.test(raw);
  if (!thinking && /thinking\.\.\./i.test(fallbackAnswer) && raw) {
    thinking = raw;
  }

  return {
    answer,
    thinking,
    hasThinking: thinking.length > 0,
    live,
  };
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
      if (level === 1) nodes.push(<h1 key={key} className={className}>{renderInlineMarkdown(textValue, key)}</h1>);
      else if (level === 2) nodes.push(<h2 key={key} className={className}>{renderInlineMarkdown(textValue, key)}</h2>);
      else if (level === 3) nodes.push(<h3 key={key} className={className}>{renderInlineMarkdown(textValue, key)}</h3>);
      else if (level === 4) nodes.push(<h4 key={key} className={className}>{renderInlineMarkdown(textValue, key)}</h4>);
      else if (level === 5) nodes.push(<h5 key={key} className={className}>{renderInlineMarkdown(textValue, key)}</h5>);
      else nodes.push(<h6 key={key} className={className}>{renderInlineMarkdown(textValue, key)}</h6>);
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
