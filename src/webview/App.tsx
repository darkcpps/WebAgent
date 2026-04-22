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
  const [activeTab, setActiveTab] = useState<'chat' | 'bridge'>('chat');
  const [expandedThinkingByMessage, setExpandedThinkingByMessage] = useState<Record<string, boolean>>({});
  const [modelByProvider, setModelByProvider] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<{ level: 'info' | 'warning' | 'error' | 'success'; message: string }>();
  const [debugOpen, setDebugOpen] = useState(true);
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

  const onNewChat = () => {
    vscode.postMessage({ type: 'newChat', providerId });
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
        <button className="primary new-chat-btn" onClick={onNewChat}>
          + New Chat
        </button>

        <div className="card compact">
          <label className="field-label">Provider</label>
          <select value={providerId} onChange={(event) => setProviderId(event.target.value as typeof providerId)}>
            {state.providers.map((provider) => (
              <option key={provider} value={provider}>
                {provider}
              </option>
            ))}
          </select>
          <label className="field-label">Model</label>
          <select
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
              <button onClick={() => vscode.postMessage({ type: 'logoutProvider', providerId })}>Sign out</button>
            ) : (
              <button onClick={() => vscode.postMessage({ type: 'loginProvider', providerId })}>Login</button>
            )}
          </div>
        </div>

        <div className="session-list">
          {state.sessions.map((session) => (
            <div key={session.id} className={`session-item ${session.id === activeSession?.id ? 'active' : ''}`}>
              <button className="session-open" onClick={() => vscode.postMessage({ type: 'setActiveSession', sessionId: session.id })}>
                <div className="session-top">
                  <span>{session.providerId}</span>
                  <span className={`status-pill ${session.status}`}>{session.status}</span>
                </div>
                <div className="session-task">{session.chatHistory.at(-1)?.content?.slice(0, 44) || 'Empty chat'}</div>
              </button>
              <button
                className="session-delete"
                title="Delete chat"
                onClick={() => vscode.postMessage({ type: 'deleteChat', sessionId: session.id })}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      </aside>

      <main className="chat-main">
        {toast ? <div className={`toast-banner ${toast.level}`}>{toast.message}</div> : null}

        <header className="chat-header">
          <div className="hero-title">ChatUI</div>
          <div className="hero-subtitle">
            {providerId} | {selectedModelId}
          </div>
          <div className="header-tabs">
            <button className={activeTab === 'chat' ? 'tab-btn active' : 'tab-btn'} onClick={() => setActiveTab('chat')}>
              Chat
            </button>
            <button className={activeTab === 'bridge' ? 'tab-btn active' : 'tab-btn'} onClick={() => setActiveTab('bridge')}>
              Bridge
            </button>
          </div>
          <button className="debug-toggle" onClick={() => setDebugOpen((value) => !value)}>
            {debugOpen ? 'Hide Debug' : 'Show Debug'}
          </button>
        </header>

        {activeTab === 'chat' ? (
          <>
            <section className="chat-scroll">
              {activeSession?.chatHistory.length ? (
                activeSession.chatHistory.map((entry, index) => {
                  const thoughtView = getThoughtView(entry.rawContent, entry.content);
                  const thinkingExpanded = Boolean(expandedThinkingByMessage[entry.id]);
                  const contentToRender =
                    entry.role === 'assistant' && thoughtView.answer.trim().length > 0 ? thoughtView.answer : entry.content;

                  return (
                    <article key={entry.id} className={`chat-bubble ${entry.role}`}>
                      <div 
                        className="chat-content"
                        onClick={() => {
                          if (entry.role === 'assistant' && (thoughtView.hasThinking || thoughtView.live)) {
                            toggleThoughtDetails(entry.id);
                          }
                        }}
                        style={entry.role === 'assistant' && (thoughtView.hasThinking || thoughtView.live) ? { cursor: 'pointer' } : undefined}
                      >
                        <MarkdownContent content={contentToRender || (entry.role === 'assistant' ? 'Thinking...' : '')} />
                        {entry.role === 'assistant' && thoughtView.hasThinking && !thinkingExpanded && !showThinking ? (
                          <div className="thinking-indicator-hint">Click to show thinking...</div>
                        ) : null}
                      </div>
                      {(showThinking || thinkingExpanded) && entry.role === 'assistant' && (thoughtView.hasThinking || thoughtView.live) ? (
                        <div className="thinking-section">
                          <button className="thinking-toggle-inline" onClick={() => toggleThoughtDetails(entry.id)}>
                            {thinkingExpanded ? 'Hide Thinking' : 'Show Thinking'}
                            {thoughtView.live ? ' (Live)' : ''}
                          </button>
                          {thinkingExpanded ? (
                            <pre className="thinking-content">{thoughtView.thinking || 'Thinking...'}</pre>
                          ) : null}
                        </div>
                      ) : null}
                      {entry.role === 'assistant' && isCapacityMessage(entry.content) ? (
                        <div className="capacity-actions">
                          <button onClick={() => onRegenerate(index, false)} disabled={isRunning || !isLoggedIn}>
                            Regenerate with current model
                          </button>
                          <button onClick={() => onRegenerate(index, true)} disabled={isRunning || !isLoggedIn}>
                            Switch to GLM-5-Turbo
                          </button>
                        </div>
                      ) : null}
                    </article>
                  );
                })
              ) : (
                <div className="empty-state">Start a new chat and send first message.</div>
              )}
              {activeSession?.approvalRequest ? (
                <div className="approval-card">
                  <div className="approval-header">
                    <strong>Action Approval Required</strong>
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
                        vscode.postMessage({
                          type: 'approve',
                          sessionId: activeSession.id,
                          actionId: activeSession.approvalRequest!.actionId,
                        })
                      }
                    >
                      Approve
                    </button>
                    <button
                      className="secondary reject-btn"
                      onClick={() =>
                        vscode.postMessage({
                          type: 'reject',
                          sessionId: activeSession.id,
                          actionId: activeSession.approvalRequest!.actionId,
                        })
                      }
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ) : null}
            </section>

            <footer className="chat-composer">
              <textarea
                rows={3}
                placeholder="Message..."
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    onSend();
                  }
                }}
              />
              <button className="primary send-btn" disabled={!canSend} onClick={onSend}>
                Send
              </button>
              <button className={`agent-toggle ${agentMode ? 'active' : ''}`} onClick={() => setAgentMode((value) => !value)}>
                Agent Mode: {agentMode ? 'On' : 'Off'}
              </button>
              <button className={`thinking-toggle ${showThinking ? 'active' : ''}`} onClick={() => setShowThinking((value) => !value)}>
                Thinking: {showThinking ? 'On' : 'Off'}
              </button>
              {!isLoggedIn ? (
                <div className="auth-warning">
                  {isBridgeMode
                    ? state.bridge.companionReachable
                      ? state.bridge.browserConnected
                        ? `Sign in on ${providerId} before sending messages.`
                        : 'Load/enable browser extension so bridge can connect.'
                      : 'Bridge companion offline. Start/restart from Bridge tab.'
                    : `Sign in on ${providerId} before sending messages.`}
                </div>
              ) : null}
            </footer>
          </>
        ) : (
          <section className="bridge-tab">
            {providerId !== 'zai' ? <div className="empty-state">Select provider `zai` to use bridge controls.</div> : null}
            <div className="card bridge-tab-card">
              <div className="bridge-title">z.ai Bridge</div>
              <div className="bridge-row">
                <span>Transport</span>
                <strong>{state.bridge.transport}</strong>
              </div>
              <div className="bridge-row">
                <span>Companion</span>
                <span className={`bridge-pill ${state.bridge.companionReachable ? 'ok' : 'bad'}`}>
                  {state.bridge.companionReachable ? 'reachable' : 'offline'}
                </span>
              </div>
              <div className="bridge-row">
                <span>Browser Link</span>
                <span className={`bridge-pill ${state.bridge.browserConnected ? 'ok' : 'bad'}`}>
                  {state.bridge.browserConnected ? 'connected' : 'not connected'}
                </span>
              </div>
              <div className="bridge-row">
                <span>z.ai Ready</span>
                <span className={`bridge-pill ${state.bridge.ready ? 'ok' : 'warn'}`}>{state.bridge.ready ? 'yes' : 'no'}</span>
              </div>
              <div className="bridge-row small">
                <span>Auto-start</span>
                <span>{state.bridge.autoStartCompanion ? 'on' : 'off'}</span>
              </div>
              <div className="bridge-row small">
                <span>Owned process</span>
                <span>{state.bridge.companionOwnedByExtension ? 'yes' : 'no'}</span>
              </div>
              {state.bridge.lastError ? <div className="bridge-error">{state.bridge.lastError}</div> : null}
              <div className="bridge-buttons">
                <button onClick={() => vscode.postMessage({ type: 'startBridgeCompanion' })}>Start</button>
                <button onClick={() => vscode.postMessage({ type: 'restartBridgeCompanion' })}>Restart</button>
                <button onClick={() => vscode.postMessage({ type: 'stopBridgeCompanion' })}>Stop</button>
              </div>
              <div className="bridge-buttons">
                <button onClick={() => vscode.postMessage({ type: 'openZaiInBrowser' })}>Open z.ai</button>
                <button onClick={() => vscode.postMessage({ type: 'openBridgeExtensionFolder' })}>Open Ext Folder</button>
              </div>
            </div>
          </section>
        )}

        {debugOpen ? (
          <section className="debug-console">
            <div className="debug-title">Debug Console</div>
            <div className="debug-list">
              {debugLogs.length ? (
                debugLogs
                  .slice(-150)
                  .map((log) => (
                    <div key={log.id} className={`debug-line ${log.level}`}>
                      <span className="debug-time">{new Date(log.timestamp).toLocaleTimeString()}</span>
                      <span className="debug-source">[{log.source}]</span>
                      <span className="debug-message">{log.message}</span>
                    </div>
                  ))
              ) : (
                <div className="debug-empty">No logs yet.</div>
              )}
            </div>
          </section>
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
          <div key={`text-${index}`} className="md-text">
            {block.text}
          </div>
        ),
      )}
    </>
  );
}
