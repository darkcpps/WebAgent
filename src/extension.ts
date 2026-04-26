import * as vscode from 'vscode';
import * as path from 'path';
import { AgentOrchestrator } from './agent/orchestrator';
import { ActionExecutor } from './agent/executor';
import { ProviderRegistry } from './providers/registry';
import { ApprovalManager } from './safety/approvalManager';
import { SafetyPolicy } from './safety/policy';
import { SessionStore } from './storage/sessionStore';
import { TerminalRunner } from './terminal/runner';
import { SessionTreeProvider } from './ui/tree/sessionTreeProvider';
import { ActivityTreeProvider } from './ui/tree/activityTreeProvider';
import { BridgeTreeProvider } from './ui/tree/bridgeTreeProvider';
import { DiffPreviewService } from './services/diffPreviewService';
import { BridgeCompanionManager } from './services/bridgeCompanionManager';
import { WebAgentPanel } from './services/webviewPanel';
import { WorkspaceContextService } from './workspace/context';
import { WorkspaceFilesService } from './workspace/files';
import { GitService } from './workspace/git';
import type { ApprovalMode, BridgeUiState, ChatMessage, ImageAttachment, ProviderId, SessionState } from './shared/types';
import type { ProviderAdapter, ProviderPrompt } from './providers/base';
import { AgentResponseParser } from './agent/parser';
import { buildPlanningPrompt, buildProviderPrompt } from './agent/planner';
import { sanitizeResponse } from './shared/utils';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const AUTO_FOLLOW_UP_DELAY_MS = 1750;
  const configuration = vscode.workspace.getConfiguration('webagentCode');
  const sessions = new SessionStore(context);
  const approvals = new ApprovalManager();
  const providers = new ProviderRegistry(context);
  const bridgeCompanion = new BridgeCompanionManager(context);
  const files = new WorkspaceFilesService(configuration);
  const git = new GitService();
  const safety = new SafetyPolicy(configuration);
  const diffPreview = new DiffPreviewService();
  const terminal = new TerminalRunner();
  const workspaceContext = new WorkspaceContextService(files);
  const executor = new ActionExecutor(files, git, safety, approvals, sessions, diffPreview, terminal);
  const orchestrator = new AgentOrchestrator(providers, workspaceContext, executor, sessions);
  const parser = new AgentResponseParser();
  const providerReady: Record<ProviderId, boolean> = {
    chatgpt: false,
    gemini: false,
    perplexity: false,
    zai: false,
  };

  context.subscriptions.push(bridgeCompanion);

  const ensureBridgeCompanion = async (providerId: ProviderId, sessionId?: string): Promise<void> => {
    if (providerId !== 'zai') {
      return;
    }
    if (providers.getZaiTransport(sessionId) !== 'bridge') {
      return;
    }
    await bridgeCompanion.ensureRunning('provider-request').catch(() => undefined);
  };

  void bridgeCompanion.ensureRunning('activate').catch(() => undefined);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('webagentCode.transport.zai') ||
        event.affectsConfiguration('webagentCode.bridge.autoStartCompanion')
      ) {
        void bridgeCompanion.ensureRunning('activate').catch(() => undefined);
      }
    }),
  );

  const collectProviderText = async (
    sessionId: string,
    providerId: ProviderId,
    onDelta?: (text: string) => void,
  ): Promise<string> => {
    const provider = providers.get(providerId, { sessionId });
    return new Promise<string>((resolve, reject) => {
      let buffer = '';
      void provider.streamEvents((event) => {
        if (event.type === 'status') {
          sessions.appendLog(sessionId, { level: 'info', source: 'provider', message: event.message });
          return;
        }
        if (event.type === 'metadata') {
          if (event.conversationId) {
            sessions.setProviderSessionId(sessionId, event.conversationId);
          }
          return;
        }
        if (event.type === 'delta') {
          buffer += event.text;
          onDelta?.(buffer);
          return;
        }
        if (event.type === 'done') {
          resolve(event.fullText || buffer);
          return;
        }
        if (event.type === 'error') {
          reject(new Error(event.message));
        }
      });
    });
  };

  const cleanFinalResponse = (text: string, options?: { preferJson?: boolean }): string => {
    const cleaned = sanitizeResponse(text, options);
    return cleaned || 'No response text was parsed from provider.';
  };

  const truncatePromptPreview = (value: string, limit = 2200): string => {
    if (value.length <= limit) {
      return value;
    }
    return `${value.slice(0, limit)}\n\n...[truncated ${value.length - limit} chars]`;
  };

  const compactText = (value: string, limit: number): string => {
    const normalized = value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .join('\n')
      .trim();
    if (normalized.length <= limit) {
      return normalized;
    }
    return `${normalized.slice(0, limit).trim()}\n...[truncated ${normalized.length - limit} chars]`;
  };

  const notifyModeComplete = (mode: 'agent' | 'plan', detail?: string): void => {
    const message =
      mode === 'plan'
        ? 'WebAgent Code: planning mode is done. Plan is ready.'
        : 'WebAgent Code: agent mode is done.';
    void vscode.window.showInformationMessage(detail ? `${message} ${detail}` : message);
  };

  const buildRegenerationHandoffPrompt = (sourceSession: SessionState, retryMessage: string): string => {
    const targetUserIndex = (() => {
      for (let index = sourceSession.chatHistory.length - 1; index >= 0; index -= 1) {
        const entry = sourceSession.chatHistory[index];
        if (entry?.role === 'user' && entry.content.trim() === retryMessage.trim()) {
          return index;
        }
      }
      for (let index = sourceSession.chatHistory.length - 1; index >= 0; index -= 1) {
        if (sourceSession.chatHistory[index]?.role === 'user') {
          return index;
        }
      }
      return -1;
    })();

    const priorMessages =
      targetUserIndex >= 0 ? sourceSession.chatHistory.slice(Math.max(0, targetUserIndex - 12), targetUserIndex) : [];
    const summarizedTurns = priorMessages
      .map((entry: ChatMessage) => {
        const role = entry.role === 'assistant' ? 'Assistant' : entry.role === 'user' ? 'User' : 'System';
        const content = sanitizeResponse(entry.rawContent || entry.content);
        if (!content || /^thinking\.\.\.$/i.test(content.trim())) {
          return undefined;
        }
        return `- ${role}: ${compactText(content, role === 'Assistant' ? 900 : 700)}`;
      })
      .filter((entry): entry is string => Boolean(entry));

    const recentActions = sourceSession.actionHistory
      .filter((action) => action.status === 'done' || action.status === 'error')
      .slice(-8)
      .map((action) => {
        const result = action.result ? ` Result: ${compactText(action.result, 240)}` : '';
        return `- ${action.type}: ${compactText(action.summary || action.type, 180)} (${action.status}).${result}`;
      });

    const contextBlocks: string[] = [];
    if (sourceSession.pendingPlan?.plan) {
      contextBlocks.push(
        [
          'Pending plan from previous chat:',
          compactText(
            `Original request: ${sourceSession.pendingPlan.originalRequest}\n\nPlan:\n${sourceSession.pendingPlan.plan}`,
            2200,
          ),
        ].join('\n'),
      );
    }
    if (summarizedTurns.length > 0) {
      contextBlocks.push(['Recent conversation summary:', ...summarizedTurns].join('\n'));
    }
    if (recentActions.length > 0) {
      contextBlocks.push(['Recent IDE action summary:', ...recentActions].join('\n'));
    }

    if (contextBlocks.length === 0) {
      return retryMessage;
    }

    return [
      'The previous chat response took longer than 5 minutes, so this is a retry in a new chat.',
      'Use the compact context below only as background. The user prompt after the separator is the task to answer now.',
      '',
      compactText(contextBlocks.join('\n\n'), 8500),
      '',
      '---',
      'User prompt to retry:',
      retryMessage,
    ].join('\n');
  };

  const buildRecentChatContext = (sessionId: string, currentUserMessageId?: string): string => {
    const session = sessions.get(sessionId);
    if (!session) {
      return '';
    }

    const currentIndex = currentUserMessageId
      ? session.chatHistory.findIndex((entry) => entry.id === currentUserMessageId)
      : -1;
    const previousMessages = (currentIndex >= 0 ? session.chatHistory.slice(0, currentIndex) : session.chatHistory)
      .filter((entry) => entry.role === 'user' || entry.role === 'assistant')
      .filter((entry) => entry.content.trim() && entry.content.trim() !== 'Working...')
      .slice(-12);

    if (previousMessages.length === 0) {
      return '';
    }

    const lines = previousMessages.map((entry) => {
      const role = entry.role === 'user' ? 'User' : 'Assistant';
      return `${role}: ${compactText(entry.content, 1200)}`;
    });

    return compactText(lines.join('\n\n'), 9000);
  };

  const buildChatAskPrompt = (
    userPrompt: string,
    options: { wasPreviouslyAgentMode: boolean; recentChatContext?: string },
  ): ProviderPrompt => {
    const systemLines = [
      'You are in Chat/Ask mode inside an IDE conversation.',
      'Respond conversationally and helpfully to the user question.',
      'Use the recent IDE conversation context to answer follow-up questions naturally. Do not repeat the context unless it is relevant.',
      'Do not output tool-action JSON and do not behave as an autonomous agent in this mode.',
      'Explain code changes clearly when asked, and ask clarifying questions if context is missing.',
      options.wasPreviouslyAgentMode
        ? 'Important: Previous agent-mode instructions in this thread are inactive. Ignore them unless the user explicitly asks to enable Agent Mode again.'
        : 'Stay in Chat/Ask mode unless the user explicitly asks to switch to Agent Mode.',
    ];

    if (options.recentChatContext?.trim()) {
      systemLines.push('', 'Recent IDE conversation context:', options.recentChatContext.trim());
    }

    return {
      systemPrompt: systemLines.join('\n'),
      userPrompt,
    };
  };

  const compactPlanForImplementation = (plan: string, limit = 7000): { text: string; truncated: boolean } => {
    const normalized = plan
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .join('\n')
      .replace(/\n{4,}/g, '\n\n\n')
      .trim();

    if (normalized.length <= limit) {
      return { text: normalized, truncated: false };
    }

    const sectionOrder = [
      /goal|intended user experience/i,
      /explicit requirements/i,
      /inferred enhancements|creative additions/i,
      /assumptions|defaults/i,
      /codebase findings/i,
      /ui\/ux|interaction/i,
      /implementation steps/i,
      /verification/i,
      /risks|tradeoffs|open questions/i,
    ];
    const lines = normalized.split(/\r?\n/);
    const selected: string[] = [];

    for (const pattern of sectionOrder) {
      const index = lines.findIndex((line) => pattern.test(line));
      if (index === -1) {
        continue;
      }
      const nextHeadingIndex = lines.findIndex((line, lineIndex) => lineIndex > index && /^#{1,4}\s+|\*\*[^*]+\*\*:?\s*$|^[A-Z][A-Za-z /&-]+:\s*$/.test(line.trim()));
      const end = nextHeadingIndex === -1 ? Math.min(lines.length, index + 18) : Math.min(nextHeadingIndex, index + 18);
      selected.push(lines.slice(index, end).join('\n'));
    }

    const compacted = selected.join('\n\n').trim();
    const fallback = normalized.slice(0, limit);
    const text = (compacted || fallback).slice(0, limit).trim();
    return {
      text: `${text}\n\n[Plan compacted for provider prompt budget. Continue by inspecting files and following the stored plan intent.]`,
      truncated: true,
    };
  };

  const buildAgentTaskFromPlan = (originalRequest: string, plan: string): { task: string; planWasCompacted: boolean } => {
    const compactPlan = compactPlanForImplementation(plan);
    return {
      task: [
      'Implement the approved Planning Mode plan below.',
      '',
      `Original request:\n${originalRequest}`,
      '',
        `Approved plan excerpt:\n${compactPlan.text}`,
      '',
      'Follow the plan, adapt if the codebase requires it, and verify the result before finishing.',
      ].join('\n'),
      planWasCompacted: compactPlan.truncated,
    };
  };

  const appendPromptPreviewLog = (
    sessionId: string,
    mode: 'chat' | 'agent' | 'plan',
    prompt: ProviderPrompt,
    round?: number,
  ): void => {
    const label = mode === 'chat' ? 'Chat/Ask' : mode === 'plan' ? 'Planning' : round ? `Agent (round ${round})` : 'Agent';
    const systemPreview = truncatePromptPreview(prompt.systemPrompt);
    const userPreview = truncatePromptPreview(prompt.userPrompt);

    sessions.appendLog(sessionId, {
      level: 'info',
      source: 'agent',
      message: `${label} prompt preview\nSystem:\n${systemPreview}\n\nUser:\n${userPreview}`,
    });
  };

  const getConversationIdSafely = async (
    provider: ProviderAdapter,
    timeoutMs = 7000,
  ): Promise<string | undefined> =>
    await new Promise<string | undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), timeoutMs);
      void provider
        .getCurrentConversationId()
        .then((conversationId) => {
          clearTimeout(timer);
          resolve(conversationId);
        })
        .catch(() => {
          clearTimeout(timer);
          resolve(undefined);
        });
    });

  const normalizeProviderError = (error: unknown): { displayMessage: string; rawMessage: string; transient: boolean } => {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const isTransientHtmlJsonError =
      /no response,\s*please try again later/i.test(rawMessage) ||
      /unexpected token '<'/i.test(rawMessage) ||
      /<!doctype/i.test(rawMessage) ||
      /not valid json/i.test(rawMessage);

    if (isTransientHtmlJsonError) {
      return {
        displayMessage:
          'Provider returned a temporary error page (likely rate-limited). Wait a bit before sending the next prompt, then try again.',
        rawMessage,
        transient: true,
      };
    }

    return {
      displayMessage: rawMessage,
      rawMessage,
      transient: false,
    };
  };

  const withTimeoutFallback = async <T>(operation: () => Promise<T>, timeoutMs: number, fallbackValue: T): Promise<T> => {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<T>((resolve) => {
      timeoutHandle = setTimeout(() => resolve(fallbackValue), timeoutMs);
    });

    try {
      return await Promise.race([operation(), timeoutPromise]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  };

  const isLikelyZaiBridgeFailure = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message : String(error);
    return /\[bridge\]|companion|z\.ai bridge|socket|BROWSER_NOT_CONNECTED|No z\.ai tab|Receiving end does not exist|message channel closed/i.test(
      message,
    );
  };

  const maybeAutoFallbackZaiToManaged = async (
    sessionId: string,
    error: unknown,
    contextLabel: string,
  ): Promise<boolean> => {
    if (providers.resolveZaiRuntime(sessionId) !== 'bridge') {
      return false;
    }
    if (!isLikelyZaiBridgeFailure(error)) {
      return false;
    }

    providers.setZaiSessionTransport(sessionId, 'playwright');
    sessions.appendLog(sessionId, {
      level: 'warning',
      source: 'provider',
      message: `Bridge runtime failed during ${contextLabel}. Auto-switched this session to managed runtime.`,
    });
    sessions.appendLog(sessionId, {
      level: 'info',
      source: 'provider',
      message: `z.ai runtime: configured=${providers.getZaiTransport(sessionId)} active=${providers.resolveZaiRuntime(
        sessionId,
      )} mode=${providers.getZaiManagedMode()}`,
    });
    console.warn(
      `[zai-runtime] Bridge failure in ${contextLabel}. Switched session ${sessionId} to managed runtime (${providers.getZaiManagedMode()}).`,
    );
    return true;
  };

  const getBridgeState = async (): Promise<BridgeUiState> => {
    const activeSessionId = sessions.getActive()?.id;
    const transport = providers.getZaiTransport(activeSessionId);
    const activeRuntime = providers.resolveZaiRuntime(activeSessionId);
    const managedMode = providers.getZaiManagedMode();
    const autoStartCompanion = vscode.workspace.getConfiguration('webagentCode').get<boolean>('bridge.autoStartCompanion', true);
    const companionReachable = await bridgeCompanion.isReachable().catch(() => false);

    let browserConnected = false;
    let ready = false;
    let loginRequired = false;
    let lastError: string | undefined;

    if (activeRuntime === 'bridge') {
      const provider = providers.get('zai', { sessionId: activeSessionId });
      if (provider.getBridgeHealth) {
        const health = await provider.getBridgeHealth().catch((error) => ({
          companionReachable,
          browserConnected: false,
          ready: false,
          loginRequired: false,
          error: error instanceof Error ? error.message : String(error),
        }));
        browserConnected = Boolean(health.browserConnected);
        ready = Boolean(health.ready);
        loginRequired = Boolean(health.loginRequired);
        lastError = health.error;
      }
    } else {
      ready = Boolean(providerReady.zai);
      loginRequired = false;
      browserConnected = ready;
    }

    return {
      transport,
      activeRuntime,
      managedMode,
      autoStartCompanion,
      companionReachable,
      companionOwnedByExtension: bridgeCompanion.isOwnedRunning(),
      browserConnected,
      ready,
      loginRequired,
      lastError,
    };
  };

  const panelCallbacks = {
      newChat: async (providerId) => {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const session = sessions.create(providerId, 'Chat session', workspaceRoot);
        sessions.setActive(session.id);
        await ensureBridgeCompanion(providerId, session.id);
        const conversationId = await providers.get(providerId, { sessionId: session.id }).startNewConversation();
        if (conversationId) {
          sessions.setProviderSessionId(session.id, conversationId);
        }
        sessions.setStatus(session.id, 'idle');
      },
      deleteChat: async (sessionId) => {
        const session = sessions.get(sessionId);
        if (!session) {
          return;
        }
        providers.clearZaiSessionTransport(sessionId);
        sessions.delete(sessionId);
      },
      startTask: async (providerId, task) => {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const session = sessions.create(providerId, task, workspaceRoot);
        await ensureBridgeCompanion(providerId, session.id);
        void orchestrator.start(session.id, providerId, task);
      },
      sendChat: async (providerId, message, modelId, sessionId, agentMode, planningMode, enableThinking, imageAttachments?: ImageAttachment[]) => {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const existing = sessionId ? sessions.get(sessionId) : undefined;
        const wasEmptySession = (existing?.chatHistory.length ?? 0) === 0;
        const session =
          existing && existing.providerId === providerId ? existing : sessions.create(providerId, 'Chat session', workspaceRoot);
        const attachmentNames = (imageAttachments ?? []).map((attachment) => attachment.name).filter(Boolean);
        const visibleUserMessage = attachmentNames.length > 0
          ? `${message}\n\nAttached images: ${attachmentNames.join(', ')}`
          : message;

        sessions.setActive(session.id);
        const userMessage = sessions.appendChatMessage(session.id, {
          role: 'user',
          content: visibleUserMessage,
          modelId,
        });
        const assistantMessage = sessions.appendChatMessage(session.id, {
          role: 'assistant',
          content: 'Working...',
          modelId: modelId && modelId !== 'auto' ? modelId : undefined,
          rawContent: '',
        });
        sessions.setStatus(session.id, 'running');

        try {
          const companionPromise = ensureBridgeCompanion(providerId, session.id);
          let provider = providers.get(providerId, { sessionId: session.id });
          let bridgeFallbackApplied = false;
          const runWithAutoFallback = async <T>(operation: () => Promise<T>, contextLabel: string): Promise<T> => {
            try {
              return await operation();
            } catch (error) {
              if (providerId === 'zai' && !bridgeFallbackApplied) {
                const switched = await maybeAutoFallbackZaiToManaged(session.id, error, contextLabel);
                if (switched) {
                  bridgeFallbackApplied = true;
                  provider = providers.get(providerId, { sessionId: session.id });
                  providerReady.zai = false;
                  return operation();
                }
              }
              throw error;
            }
          };

          if (providerId === 'zai') {
            const configured = providers.getZaiTransport(session.id);
            const active = providers.resolveZaiRuntime(session.id);
            const managedMode = providers.getZaiManagedMode();
            sessions.appendLog(session.id, {
              level: 'info',
              source: 'provider',
              message: `z.ai runtime selected: configured=${configured} active=${active}${
                active === 'playwright' ? ` mode=${managedMode}` : ''
              }`,
            });
          }

          // Only perform heavy readiness checks if we haven't checked recently or it's a new provider
          if (!providerReady[providerId] || !existing) {
            await companionPromise;
            const readiness = await runWithAutoFallback(() => provider.checkReady(), 'checkReady');
            providerReady[providerId] = readiness.ready;
            if (!readiness.ready) {
              if (readiness.loginRequired) {
                throw new Error(`${providerId} is not signed in. Click Login first.`);
              }
              throw new Error(`${providerId} is not ready yet.`);
            }
          }

          // --- Session navigation logic (simplified) ---
          // Step 1: Check what conversation the browser is currently on.
          const browserConversationId = await runWithAutoFallback(
            () => provider.getCurrentConversationId(),
            'getCurrentConversationId',
          ).catch(() => undefined);
          const sessionConversationId = sessions.get(session.id)?.providerSessionId;

          // Step 2: Only navigate if we MUST switch to a different conversation.
          // If the session has a stored conversation ID and the browser is on a DIFFERENT one, navigate.
          if (sessionConversationId && browserConversationId !== sessionConversationId) {
            sessions.appendLog(session.id, {
              level: 'info',
              source: 'agent',
              message: `Switching browser to conversation ${sessionConversationId}...`,
            });
            await runWithAutoFallback(() => provider.openConversation(sessionConversationId), 'openConversation').catch(() => false);
          }
          // For a brand-new local session, never inherit a pre-existing browser conversation.
          // Force the browser back to "new chat" context if we detect an active thread URL.
          if (!sessionConversationId && wasEmptySession && browserConversationId) {
            sessions.appendLog(session.id, {
              level: 'info',
              source: 'agent',
              message: 'Fresh chat requested. Resetting browser to new conversation context...',
            });
            await runWithAutoFallback(() => provider.startNewConversation(), 'startNewConversation').catch(() => undefined);

            let clearedConversation = false;
            for (let attempt = 0; attempt < 8; attempt += 1) {
              await new Promise((resolve) => setTimeout(resolve, 250));
              const currentConversation = await runWithAutoFallback(
                () => getConversationIdSafely(provider, 3000),
                'getCurrentConversationId',
              ).catch(() => undefined);
              if (!currentConversation) {
                clearedConversation = true;
                break;
              }
            }

            if (!clearedConversation) {
              throw new Error('Could not switch z.ai browser to a fresh chat context.');
            }
          }

          // For non-new sessions that somehow lack a stored ID, adopt the currently open browser thread.
          if (!sessionConversationId && !wasEmptySession && browserConversationId) {
            sessions.setProviderSessionId(session.id, browserConversationId);
          }

          const supportsThinkingControl = providerId === 'zai' || providerId === 'perplexity';
          let requestedModelId = modelId;

          if (providerId === 'perplexity') {
            if (requestedModelId && requestedModelId !== 'auto') {
              sessions.appendLog(session.id, {
                level: 'info',
                source: 'provider',
                message:
                  'Perplexity model selection is controlled in the browser. To select a model, choose it in the Perplexity browser window opened by the IDE.',
              });
            }
            requestedModelId = undefined;
          }

          // Model selection
          const shouldAttemptModelSelection =
            Boolean(requestedModelId) && requestedModelId !== 'auto';
          if (shouldAttemptModelSelection && requestedModelId) {
            const modelSelectTimeoutMs = providerId === 'perplexity' ? 20000 : 12000;
            const selected = await runWithAutoFallback(
              () => withTimeoutFallback(() => provider.selectModel(requestedModelId!), modelSelectTimeoutMs, false),
              'selectModel',
            ).catch(() => false);
            if (!selected) {
              const failureMessage =
                providerId === 'perplexity' && requestedModelId !== 'auto'
                  ? `Perplexity model switch failed for "${requestedModelId}". Attempting Auto fallback.`
                  : `Could not select model ${requestedModelId} quickly. Proceeding with current/default model.`;
              sessions.appendLog(session.id, {
                level: providerId === 'perplexity' && requestedModelId !== 'auto' ? 'error' : 'warning',
                source: 'provider',
                message: failureMessage,
              });
              if (providerId === 'perplexity' && requestedModelId !== 'auto') {
                const recoveredToAuto = await runWithAutoFallback(
                  () => withTimeoutFallback(() => provider.selectModel('auto'), 8000, false),
                  'selectModel(auto-fallback)',
                ).catch(() => false);
                sessions.appendLog(session.id, {
                  level: recoveredToAuto ? 'warning' : 'error',
                  source: 'provider',
                  message: recoveredToAuto
                    ? `Perplexity failed to switch to "${requestedModelId}", fell back to Auto for this send.`
                    : 'Perplexity model switch failed and Auto fallback could not be confirmed. Proceeding with current browser model.',
                });
              }
            } else {
              const selectedModelLabel =
                provider.listModels().find((entry) => entry.id === requestedModelId)?.label || requestedModelId;
              sessions.appendLog(session.id, {
                level: 'info',
                source: 'provider',
                message:
                  providerId === 'zai'
                    ? `Model selected: ${selectedModelLabel} (${requestedModelId}). Thinking=${enableThinking === true ? 'on' : 'off'}. Request payload override armed for /api/v1/chats/new and /api/v2/chat/completions.`
                    : providerId === 'perplexity'
                      ? `Model selected: ${selectedModelLabel} (${requestedModelId}). Thinking=${enableThinking === true ? 'on' : 'off'}. Perplexity ask payload will apply reasoning flags when available.`
                    : `Model selected: ${selectedModelLabel} (${requestedModelId})`,
              });
            }
          }

          const trimmedMessage = message.trim();
          const explicitAgent = /^\/agent\s+/i.test(trimmedMessage);
          const explicitPlan = /^\/plan\s+/i.test(trimmedMessage);
          const explicitChat = /^\/chat\s+/i.test(trimmedMessage);
          const activePendingPlan = sessions.get(session.id)?.pendingPlan;
          const previousPromptMode = sessions.get(session.id)?.lastPromptMode;
          const promptWithoutCommand = explicitAgent
            ? trimmedMessage.replace(/^\/agent\s+/i, '').trim()
            : explicitPlan
              ? trimmedMessage.replace(/^\/plan\s+/i, '').trim()
              : explicitChat
                ? trimmedMessage.replace(/^\/chat\s+/i, '').trim()
                : trimmedMessage;
          const isImplementPlanRequest = /^implement\s+(this\s+|the\s+)?plan$/i.test(promptWithoutCommand);
          const implementationTask =
            isImplementPlanRequest && activePendingPlan
              ? buildAgentTaskFromPlan(activePendingPlan.originalRequest, activePendingPlan.plan)
              : undefined;
          const usePlanningMode = (Boolean(planningMode) || explicitPlan) && !(isImplementPlanRequest && activePendingPlan);
          const keepAgentSessionActive = previousPromptMode === 'agent' && !explicitChat && !planningMode;
          const useAgentTools = !usePlanningMode && (Boolean(agentMode) || explicitAgent || keepAgentSessionActive);
          const chatPrompt = implementationTask ? implementationTask.task : promptWithoutCommand;
          const contextTask = implementationTask && activePendingPlan ? activePendingPlan.originalRequest : chatPrompt;
          const requestThinking = supportsThinkingControl ? enableThinking : undefined;
          const requestImageAttachments = providerId === 'chatgpt' || providerId === 'perplexity' ? imageAttachments ?? [] : [];
          if ((imageAttachments?.length ?? 0) > 0 && requestImageAttachments.length === 0) {
            sessions.appendLog(session.id, {
              level: 'warning',
              source: 'agent',
              message: `Image attachments are currently supported for ChatGPT and Perplexity only; ignoring ${imageAttachments!.length} attachment(s).`,
            });
          }
          const wasPreviouslyAgentMode = previousPromptMode === 'agent';
          const resolvedAgentTools = useAgentTools || (isImplementPlanRequest && Boolean(activePendingPlan));
          sessions.update(session.id, {
            lastPromptMode: usePlanningMode ? 'plan' : resolvedAgentTools ? 'agent' : 'chat',
            pendingPlan: implementationTask ? undefined : activePendingPlan,
          });
          if (!chatPrompt) {
            throw new Error('Empty message.');
          }
          if (implementationTask?.planWasCompacted) {
            sessions.appendLog(session.id, {
              level: 'info',
              source: 'agent',
              message: 'Approved plan was compacted before implementation to stay within provider prompt limits.',
            });
          }

          if (usePlanningMode) {
            const repoContext = await workspaceContext.build(chatPrompt);
            const existingPlan = activePendingPlan
              ? {
                  originalRequest: activePendingPlan.originalRequest,
                  plan: activePendingPlan.plan,
                }
              : undefined;
            const prompt = buildPlanningPrompt(chatPrompt, repoContext, existingPlan);
            appendPromptPreviewLog(session.id, 'plan', prompt);
            await runWithAutoFallback(
              () => provider.sendPrompt({ ...prompt, enableThinking: requestThinking, imageAttachments: requestImageAttachments }),
              'sendPrompt(plan)',
            );

            const responseText = await runWithAutoFallback(
              () => collectProviderText(session.id, providerId),
              'streamEvents(plan)',
            );
            const cleaned = cleanFinalResponse(responseText);
            sessions.appendRawResponse(session.id, cleaned);
            sessions.update(session.id, {
              pendingPlan: {
                originalRequest: activePendingPlan?.originalRequest ?? chatPrompt,
                plan: cleaned,
                createdAt: Date.now(),
              },
            });
            if (assistantMessage) {
              sessions.updateChatMessage(session.id, assistantMessage.id, {
                content: cleaned,
                rawContent: responseText,
              });
            }
            sessions.setStatus(session.id, 'done');
            notifyModeComplete('plan');
            await new Promise((r) => setTimeout(r, 1500));
            const conversationId = await runWithAutoFallback(
              () => getConversationIdSafely(provider),
              'getCurrentConversationId',
            ).catch(() => undefined);
            if (conversationId) {
              sessions.setProviderSessionId(session.id, conversationId);
              sessions.appendLog(session.id, {
                level: 'info',
                source: 'agent',
                message: `Session locked to conversation: ${conversationId}`,
              });
            }
            return;
          }

          if (!resolvedAgentTools) {
            const prompt = buildChatAskPrompt(chatPrompt, {
              wasPreviouslyAgentMode,
              recentChatContext: buildRecentChatContext(session.id, userMessage?.id),
            });
            appendPromptPreviewLog(session.id, 'chat', prompt);
            await runWithAutoFallback(
              () => provider.sendPrompt({ ...prompt, enableThinking: requestThinking, imageAttachments: requestImageAttachments }),
              'sendPrompt(chat)',
            );

            const responseText = await runWithAutoFallback(
              () => collectProviderText(session.id, providerId),
              'streamEvents(chat)',
            );
            const cleaned = cleanFinalResponse(responseText);
            sessions.appendRawResponse(session.id, cleaned);
            if (assistantMessage) {
              sessions.updateChatMessage(session.id, assistantMessage.id, {
                content: cleaned,
                rawContent: responseText,
              });
            }
            sessions.setStatus(session.id, 'done');
            // Always capture the browser URL after the response and lock it to this session.
            // Z.ai creates the /c/UUID path during response generation.
            await new Promise((r) => setTimeout(r, 1500));
            const conversationId = await runWithAutoFallback(
              () => getConversationIdSafely(provider),
              'getCurrentConversationId',
            ).catch(() => undefined);
            if (conversationId) {
              sessions.setProviderSessionId(session.id, conversationId);
              sessions.appendLog(session.id, {
                level: 'info',
                source: 'agent',
                message: `Session locked to conversation: ${conversationId}`,
              });
            }
            return;
          }


          const repoContext = await workspaceContext.build(contextTask);
          const toolResults: string[] = [];
          let finalText = '';
          let lastRawResponse = '';
          const actionUpdates: string[] = [];
          let executedActionCount = 0;
          let failedActionCount = 0;
          let endedByAskUser = false;
          let invalidToolResponseCount = 0;
          let autoCorrectionCount = 0;
          let codeChangesApplied = false;
          let verificationAttempted = false;
          let verificationPassed = false;
          let needsVerification = false;
          let verificationSummary = '';
          let verificationFailureDetail = '';

          const compact = (value: string, limit = 220): string => {
            const normalized = value.replace(/\s+/g, ' ').trim();
            if (normalized.length <= limit) {
              return normalized;
            }
            return `${normalized.slice(0, limit)}...`;
          };

          const isCodeMutationAction = (actionType: string): boolean =>
            ['edit_file', 'create_file', 'delete_file', 'rename_file'].includes(actionType);

          const isFailedActionMessage = (message: string): boolean =>
            /^(Action failed:|Blocked action |User rejected action )/i.test(message.trim());

          const isPrematureAccessBlocker = (message: string): boolean =>
            /(files?|workspace|repository|repo).{0,80}(unavailable|not available|inaccessible|not accessible|not present|missing)|sandbox only exposes|could not safely implement|provide the actual project files/i.test(
              message,
            );

          const isPrematureIntentFinish = (message: string): boolean =>
            /\b(now\s+i\s+have\s+enough|let\s+me\s+build|i(?:'ll| will)\s+(?:build|create|implement|modify|edit|make)|i\s+can\s+(?:build|create|implement|modify|edit|make)|going\s+to\s+(?:build|create|implement|modify|edit|make))\b/i.test(
              message,
            );

          const hasWorkspaceDiscoveryResult = (): boolean =>
            toolResults.some((result) => /^(list_files|search_files|read_file):/i.test(result.trim()));

          const parseExitCode = (message: string): number | undefined => {
            const raw = message.match(/Exit code:\s*([^\n]+)/i)?.[1]?.trim();
            if (!raw) {
              return undefined;
            }
            const parsed = Number(raw);
            return Number.isFinite(parsed) ? parsed : undefined;
          };

          const detectVerificationCommands = async (): Promise<string[]> => {
            try {
              const packageJsonRaw = await files.readFile('package.json');
              const parsed = JSON.parse(packageJsonRaw) as { scripts?: Record<string, unknown> };
              const scripts = parsed?.scripts ?? {};
              const commands: string[] = [];

              if (typeof scripts.check === 'string') {
                commands.push('cmd /c npm run check');
              }
              if (typeof scripts.test === 'string') {
                commands.push('cmd /c npm run test');
              }
              if (typeof scripts.build === 'string') {
                commands.push('cmd /c npm run build');
              }

              if (commands.length > 0) {
                return commands.slice(0, 2);
              }
            } catch {
              // Not a Node workspace or package.json is unavailable.
            }

            try {
              const pyproject = await files.readFile('pyproject.toml');
              if (/\[tool\.pytest|pytest/i.test(pyproject)) {
                return ['python -m pytest'];
              }
            } catch {
              // Ignore.
            }

            try {
              await files.readFile('requirements.txt');
              return ['python -m pytest'];
            } catch {
              // Ignore.
            }

            return [];
          };

          const describeAction = (action: {
            type: string;
            summary?: string;
            path?: string;
            query?: string;
            command?: string;
            fromPath?: string;
            toPath?: string;
          }): string => {
            const summary = action.summary?.trim();
            const withSummary = (base: string): string => (summary ? `${base} - ${compact(summary, 90)}` : base);

            switch (action.type) {
              case 'read_file':
                return withSummary(`Reading ${action.path ?? 'file'}`);
              case 'edit_file':
                return withSummary(`Modifying ${action.path ?? 'file'}`);
              case 'create_file':
                return withSummary(`Creating ${action.path ?? 'file'}`);
              case 'delete_file':
                return withSummary(`Deleting ${action.path ?? 'file'}`);
              case 'rename_file':
                return withSummary(`Renaming ${action.fromPath ?? 'source'} -> ${action.toPath ?? 'target'}`);
              case 'search_files':
                return withSummary(`Searching "${compact(action.query ?? '', 80)}"`);
              case 'list_files':
                return withSummary('Listing files');
              case 'run_command':
                return withSummary(`Running command ${compact(action.command ?? '', 80)}`);
              case 'get_git_diff':
                return withSummary('Reading git diff');
              case 'ask_user':
                return withSummary('Asking for your input');
              case 'finish':
                return withSummary('Finalizing response');
              default:
                return withSummary(action.type);
            }
          };

          const describeActionOutcome = (
            action: {
              type: string;
              path?: string;
              fromPath?: string;
              toPath?: string;
              command?: string;
            },
            resultMessage: string,
          ): string => {
            const trimmed = resultMessage.trim();
            if (/^(Action failed:|Blocked action )/i.test(trimmed)) {
              const detail = trimmed.replace(/^(Action failed:|Blocked action )/i, '').trim();
              return `Failed: ${compact(detail, 130)}`;
            }

            switch (action.type) {
              case 'read_file':
                return `Read ${action.path ?? 'file'}`;
              case 'edit_file':
                return `Edited ${action.path ?? 'file'}`;
              case 'create_file':
                return `Created ${action.path ?? 'file'}`;
              case 'delete_file':
                return `Deleted ${action.path ?? 'file'}`;
              case 'rename_file':
                return `Renamed ${action.fromPath ?? 'source'} -> ${action.toPath ?? 'target'}`;
              case 'search_files':
                return 'Search complete';
              case 'list_files':
                return 'File list ready';
              case 'run_command': {
                const exitCode = trimmed.match(/Exit code:\s*([^\n]+)/i)?.[1]?.trim();
                const cmd = compact(action.command ?? '', 60);
                return exitCode ? `Command finished (${cmd}) [exit ${exitCode}]` : `Command finished (${cmd})`;
              }
              case 'get_git_diff':
                return 'Git diff ready';
              case 'ask_user':
                return 'Waiting for user input';
              case 'finish':
                return 'Finished';
              default:
                return compact(trimmed, 140) || 'Done';
            }
          };

          const pushActionUpdate = (line: string): void => {
            actionUpdates.push(line);
            if (actionUpdates.length > 20) {
              actionUpdates.shift();
            }

            if (assistantMessage) {
              const liveLines = actionUpdates.slice(-6);
              const liveContent = ['Working...', '', ...liveLines.map((entry, idx) => `${idx + 1}. ${entry}`)].join('\n');
              sessions.updateChatMessage(session.id, assistantMessage.id, {
                content: liveContent,
                rawContent: liveContent,
              });
            }
          };

          const trimForToolPrompt = (actionType: string, value: string): string => {
            const limitByAction: Record<string, number> = {
              read_file: 70000,
              search_files: 6000,
              list_files: 5000,
              run_command: 8000,
              get_git_diff: 8000,
            };
            const limit = limitByAction[actionType] ?? 3000;
            if (value.length <= limit) {
              return value;
            }
            return `${value.slice(0, limit)}\n...[truncated ${value.length - limit} chars]`;
          };

          for (let round = 0; round < 25; round += 1) {
            if (round > 0) {
              sessions.appendLog(session.id, {
                level: 'info',
                source: 'provider',
                message: `Waiting ${AUTO_FOLLOW_UP_DELAY_MS / 1000}s before automatic follow-up prompt...`,
              });
              await new Promise((resolve) => setTimeout(resolve, AUTO_FOLLOW_UP_DELAY_MS));
            }
            const prompt = buildProviderPrompt(chatPrompt, repoContext, toolResults);
            appendPromptPreviewLog(session.id, 'agent', prompt, round + 1);
            await runWithAutoFallback(
              () => provider.sendPrompt({
                ...prompt,
                enableThinking: requestThinking,
                imageAttachments: round === 0 ? requestImageAttachments : undefined,
              }),
              `sendPrompt(agent round ${round + 1})`,
            );

            const responseText = await runWithAutoFallback(
              () => collectProviderText(session.id, providerId),
              `streamEvents(agent round ${round + 1})`,
            );
            lastRawResponse = responseText;
            
            const cleaned = cleanFinalResponse(responseText, { preferJson: true });
            sessions.appendRawResponse(session.id, cleaned);

            let parsed;
            try {
              parsed = parser.parse(responseText);
            } catch {
              try {
                parsed = parser.parse(cleaned);
              } catch (parseError) {
                invalidToolResponseCount += 1;
                const parseErrorMessage = parseError instanceof Error ? parseError.message : String(parseError);
                sessions.appendLog(session.id, {
                  level: 'warning',
                  source: 'agent',
                  message: `Could not parse tool JSON in round ${round + 1}: ${parseErrorMessage}`,
                });

                if (invalidToolResponseCount <= 4) {
                  autoCorrectionCount += 1;
                  const responsePreview = cleanFinalResponse(responseText).slice(0, 1200);
                  toolResults.push(
                    [
                      'SYSTEM_FEEDBACK: Your previous response did not use a valid executable tool JSON object.',
                      `Parse error: ${parseErrorMessage}`,
                      'Your next response must be raw JSON only. The first character must be `{` and the last character must be `}`.',
                      'Do not include prose, Markdown fences, headings, bullets, XML tags, or explanations outside the JSON object.',
                      'Respond with exactly this shape:',
                      '{"summary":"...","actions":[{"type":"list_files|read_file|search_files|edit_file|create_file|delete_file|rename_file|run_command|ask_user|finish", ...}]}',
                      'Use only allowed tool names. If uncertain, use read_file/search_files first.',
                      `Previous invalid response (truncated): ${responsePreview || '[empty]'}`,
                    ].join('\n'),
                  );
                  if (toolResults.length > 10) {
                    toolResults.shift();
                  }
                  pushActionUpdate('Auto-recovery: requested valid tool JSON after invalid tool/output response.');
                  continue;
                }

                finalText = [
                  'Need your input to continue.',
                  'The model repeatedly returned invalid tool output and could not execute actions in IDE.',
                  'Try again or simplify the request.',
                ].join('\n');
                endedByAskUser = true;
                break;
              }
            }

            invalidToolResponseCount = 0;

            if (parsed.summary) {
              sessions.appendLog(session.id, { level: 'info', source: 'provider', message: parsed.summary });
              pushActionUpdate(`Planning: ${compact(parsed.summary, 160)}`);
            }

            const hasNonTerminalActions = parsed.actions.some((action) => action.type !== 'ask_user' && action.type !== 'finish');

            for (const action of parsed.actions) {
              if (action.type === 'finish' && hasNonTerminalActions) {
                sessions.appendLog(session.id, {
                  level: 'warning',
                  source: 'agent',
                  message: 'Ignoring mixed finish action; sending tool outputs back to AI for the next round.',
                });
                pushActionUpdate('Continuing: sent tool outputs back to AI for follow-up reasoning.');
                continue;
              }

              if (action.type === 'finish' && isPrematureAccessBlocker(action.result) && !hasWorkspaceDiscoveryResult()) {
                sessions.appendLog(session.id, {
                  level: 'warning',
                  source: 'agent',
                  message: 'Rejected premature no-access finish; asking model to use IDE file tools first.',
                });
                toolResults.push(
                  [
                    'SYSTEM_FEEDBACK: Do not finish by saying repository files are unavailable based on your model/runtime environment.',
                    'Your next response must be raw JSON only. No prose or Markdown outside the JSON object.',
                    'You are inside an IDE agent loop. To access the workspace, emit JSON tool calls and the IDE will return results.',
                    'Start with {"type":"list_files","limit":100} or {"type":"search_files","query":"<relevant term>"} before deciding files are missing.',
                    `Rejected finish result: ${compact(action.result, 500)}`,
                  ].join('\n'),
                );
                if (toolResults.length > 10) {
                  toolResults.shift();
                }
                pushActionUpdate('Auto-recovery: rejected premature no-access finish and requested file discovery.');
                continue;
              }

              if (action.type === 'finish' && executedActionCount === 0 && isPrematureIntentFinish(action.result)) {
                sessions.appendLog(session.id, {
                  level: 'warning',
                  source: 'agent',
                  message: 'Rejected intent-only finish; asking model to emit executable tool actions.',
                });
                toolResults.push(
                  [
                    'SYSTEM_FEEDBACK: Do not finish with a statement about what you are about to build or edit.',
                    'Your next response must be raw JSON only. No prose or Markdown outside the JSON object.',
                    'The IDE can only execute JSON tool actions. Emit list_files/search_files/read_file/create_file/edit_file/run_command actions as needed.',
                    'Use finish only after the requested work has actually been completed by prior tool actions.',
                    `Rejected finish result: ${compact(action.result, 500)}`,
                  ].join('\n'),
                );
                if (toolResults.length > 10) {
                  toolResults.shift();
                }
                pushActionUpdate('Auto-recovery: rejected intent-only finish and requested executable actions.');
                continue;
              }

              const result = await executor.execute(session.id, action);
              executedActionCount += 1;
              if (isFailedActionMessage(result.message)) {
                failedActionCount += 1;
              }
              if (isCodeMutationAction(action.type) && !isFailedActionMessage(result.message)) {
                codeChangesApplied = true;
                needsVerification = true;
                verificationPassed = false;
              }
              if (action.type === 'run_command' && codeChangesApplied) {
                verificationAttempted = true;
                const exitCode = parseExitCode(result.message);
                if (!isFailedActionMessage(result.message) && exitCode === 0) {
                  verificationPassed = true;
                  needsVerification = false;
                  verificationSummary = 'Verification command completed successfully.';
                } else {
                  verificationFailureDetail = compact(result.message, 180);
                }
              }
              toolResults.push(`${action.type}: ${trimForToolPrompt(action.type, result.message)}`);
              if (toolResults.length > 10) {
                toolResults.shift();
              }
              const actionLabel = describeAction(action);
              const outcomeLabel = describeActionOutcome(action, result.message);
              pushActionUpdate(`${actionLabel}... ${outcomeLabel}`);
              finalText = result.message;

              if (isFailedActionMessage(result.message)) {
                if (autoCorrectionCount < 4) {
                  autoCorrectionCount += 1;
                  toolResults.push(
                    [
                      'SYSTEM_FEEDBACK: The previous action failed or was blocked in IDE execution.',
                      `Failure detail: ${result.message}`,
                      'Your next response must be raw JSON only. No prose or Markdown outside the JSON object.',
                      'Adjust your next action to use valid workspace-relative paths and supported tools.',
                      'If editing, ensure you read_file the exact target first.',
                    ].join('\n'),
                  );
                  if (toolResults.length > 10) {
                    toolResults.shift();
                  }
                }
              }

              if (action.type === 'ask_user' || action.type === 'finish' || result.done) {
                if (action.type === 'ask_user') {
                  endedByAskUser = true;
                }
                finalText = result.message;
                round = 99;
                break;
              }
            }
          }

          if (!endedByAskUser && codeChangesApplied && needsVerification && !verificationPassed) {
            const verificationCommands = await detectVerificationCommands();
            if (verificationCommands.length === 0) {
              verificationAttempted = true;
              verificationFailureDetail = 'No project verification command was detected automatically.';
              pushActionUpdate('Verification skipped: no test/build/check command detected.');
            } else {
              for (const command of verificationCommands) {
                const verificationAction = {
                  type: 'run_command' as const,
                  command,
                  summary: 'Automatic verification before final response',
                };
                const verifyResult = await executor.execute(session.id, verificationAction);
                executedActionCount += 1;
                if (isFailedActionMessage(verifyResult.message)) {
                  failedActionCount += 1;
                }
                toolResults.push(`run_command: ${trimForToolPrompt('run_command', verifyResult.message)}`);
                if (toolResults.length > 10) {
                  toolResults.shift();
                }

                const verificationOutcome = describeActionOutcome(verificationAction, verifyResult.message);
                pushActionUpdate(`Verification... ${verificationOutcome}`);
                verificationAttempted = true;

                const exitCode = parseExitCode(verifyResult.message);
                if (!isFailedActionMessage(verifyResult.message) && exitCode === 0) {
                  verificationPassed = true;
                  needsVerification = false;
                  verificationSummary = `Verified with "${command}".`;
                  break;
                }

                verificationFailureDetail = compact(verifyResult.message, 180);
              }
            }
          }

          if (endedByAskUser) {
            const followUpQuestion = compact(finalText || 'I need your input to continue.', 360);
            const recentUpdates = actionUpdates.slice(-5);
            finalText = [
              'Need your input to continue.',
              `Question: ${followUpQuestion}`,
              ...(recentUpdates.length > 0 ? ['', 'Recent actions:', ...recentUpdates.map((entry, idx) => `${idx + 1}. ${entry}`)] : []),
            ].join('\n');
          } else {
            const completionLine =
              executedActionCount > 0
                ? `Task complete. Ran ${executedActionCount} action${executedActionCount === 1 ? '' : 's'}.`
                : 'Task complete.';
            const failureLine =
              failedActionCount > 0
                ? `${failedActionCount} action${failedActionCount === 1 ? '' : 's'} failed or were blocked.`
                : '';
            const verificationLine = codeChangesApplied
              ? verificationPassed
                ? `Verification: ${verificationSummary || 'completed successfully.'}`
                : 'Verification: could not be completed automatically. Please test locally.'
              : '';
            const outcome = finalText ? compact(finalText, 300) : '';
            const recentUpdates = actionUpdates.slice(-6);
            finalText = [
              completionLine,
              ...(failureLine ? [failureLine] : []),
              ...(verificationLine ? [verificationLine] : []),
              ...(!verificationPassed && verificationFailureDetail ? [`Verification detail: ${compact(verificationFailureDetail, 220)}`] : []),
              ...(recentUpdates.length > 0 ? ['', 'Recent actions:', ...recentUpdates.map((entry, idx) => `${idx + 1}. ${entry}`)] : []),
              ...(outcome ? ['', `Result: ${outcome}`] : []),
            ].join('\n');
          }

          if (!finalText.trim() || /^working\.\.\.$/i.test(finalText.trim())) {
            finalText = endedByAskUser ? 'Need your input to continue.' : 'Task complete.';
          }

          if (assistantMessage) {
            sessions.updateChatMessage(session.id, assistantMessage.id, {
              content: finalText,
              rawContent: finalText,
            });
          }
          if (!endedByAskUser && implementationTask) {
            sessions.update(session.id, { pendingPlan: undefined });
          }
          sessions.setStatus(session.id, 'done');
          if (!endedByAskUser) {
            notifyModeComplete('agent');
          }
          sessions.appendLog(session.id, {
            level: endedByAskUser ? 'info' : 'success',
            source: 'agent',
            message: endedByAskUser ? 'Agent is waiting for user input.' : 'Agent task completed.',
          });
          const conversationId = await runWithAutoFallback(
            () => getConversationIdSafely(provider),
            'getCurrentConversationId',
          ).catch(() => undefined);
          if (conversationId) {
            sessions.setProviderSessionId(session.id, conversationId);
            sessions.appendLog(session.id, {
              level: 'info',
              source: 'agent',
              message: `Session locked to conversation: ${conversationId}`,
            });
          }
        } catch (error) {
          const normalizedError = normalizeProviderError(error);
          if (assistantMessage) {
            sessions.updateChatMessage(session.id, assistantMessage.id, {
              content: `Error: ${normalizedError.displayMessage}`,
            });
          }
          if (normalizedError.transient) {
            sessions.appendLog(session.id, {
              level: 'warning',
              source: 'provider',
              message: `Transient provider issue detected. ${normalizedError.displayMessage}`,
            });
            sessions.appendLog(session.id, {
              level: 'info',
              source: 'provider',
              message: `Raw provider error: ${normalizedError.rawMessage}`,
            });
          }
          sessions.setStatus(session.id, 'error');
          sessions.appendLog(session.id, {
            level: 'error',
            source: 'agent',
            message: normalizedError.displayMessage,
          });
          throw new Error(normalizedError.displayMessage);
        }
      },
      regenerateChatInNewSession: async (
        providerId: ProviderId,
        sourceSessionId: string,
        message: string,
        modelId?: string,
        agentMode?: boolean,
        planningMode?: boolean,
        enableThinking?: boolean,
      ) => {
        const sourceSession = sessions.get(sourceSessionId);
        const regeneratedMessage = sourceSession ? buildRegenerationHandoffPrompt(sourceSession, message) : message;
        if (sourceSession?.status === 'running') {
          orchestrator.stop(sourceSessionId);
          await providers.get(providerId, { sessionId: sourceSessionId }).stop().catch(() => undefined);
          sessions.setStatus(sourceSessionId, 'stopped');
          sessions.appendLog(sourceSessionId, {
            level: 'warning',
            source: 'agent',
            message: 'Stopped long-running response before regenerating in a new chat.',
          });
        }
        await panelCallbacks.sendChat(providerId, regeneratedMessage, modelId, undefined, agentMode, planningMode, enableThinking);
      },
      stopTask: async (sessionId) => {
        orchestrator.stop(sessionId);
        const session = sessions.get(sessionId);
        if (session) {
          await providers.get(session.providerId, { sessionId }).stop().catch(() => undefined);
        }
        sessions.setStatus(sessionId, 'stopped');
      },
      loginProvider: async (providerId) => {
        await ensureBridgeCompanion(providerId);
        if (providerId === 'zai') {
          const runtime = providers.resolveZaiRuntime(sessions.getActive()?.id);
          const mode = providers.getZaiManagedMode();
          console.log(`[zai-runtime] Login requested. activeRuntime=${runtime}${runtime === 'playwright' ? ` mode=${mode}` : ''}`);
          if (runtime === 'playwright' && mode === 'headless') {
            void vscode.window.showInformationMessage(
              'z.ai login will open in visible mode once. After login, runtime returns to headless background mode.',
            );
          }
        }
        await providers.get(providerId).login();
      },
      logoutProvider: async (providerId) => {
        const loggedOut = await providers.get(providerId).logout();
        providerReady[providerId] = !loggedOut;
        return loggedOut;
      },
      checkProviderReady: async (providerId) => {
        await ensureBridgeCompanion(providerId);
        const readiness = await providers.get(providerId).checkReady();
        providerReady[providerId] = readiness.ready;
        return readiness;
      },
      refreshProviderModels: async (providerId) => {
        await ensureBridgeCompanion(providerId);
        const refreshed = await providers.get(providerId).refreshModels();
        return refreshed.length;
      },
      resetConversation: async (providerId) => {
        await ensureBridgeCompanion(providerId);
        await providers.get(providerId).resetConversation();
      },
      approve: async (_sessionId, actionId) => {
        approvals.approve(actionId);
      },
      reject: async (_sessionId, actionId) => {
        approvals.reject(actionId);
      },
      setActiveSession: (sessionId) => {
        sessions.setActive(sessionId);
        const session = sessions.get(sessionId);
        if (session?.providerSessionId) {
          void providers.get(session.providerId, { sessionId }).openConversation(session.providerSessionId);
        }
      },
      getProviderReadyState: () => ({ ...providerReady }),
      getBridgeState,
      startBridgeCompanion: async () => {
        await bridgeCompanion.ensureRunning('manual');
        bridgeCompanion.showLogs(true);
      },
      stopBridgeCompanion: async () => {
        await bridgeCompanion.stopOwnedProcess();
      },
      restartBridgeCompanion: async () => {
        await bridgeCompanion.restartOwnedProcess();
        bridgeCompanion.showLogs(true);
      },
      openBridgeExtensionFolder: async () => {
        const extensionFolder = path.join(context.extensionUri.fsPath, 'resources', 'zai-browser-extension');
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(extensionFolder));
      },
      openZaiInBrowser: async () => {
        await vscode.env.openExternal(vscode.Uri.parse('https://chat.z.ai/'));
      },
      setApprovalMode: async (mode: ApprovalMode) => {
        if (mode !== 'ask-before-action' && mode !== 'auto-apply-safe-edits' && mode !== 'view-only') {
          throw new Error(`Unsupported approval mode: ${mode}`);
        }
        await vscode.workspace.getConfiguration('webagentCode').update('approvalMode', mode, vscode.ConfigurationTarget.Workspace);
      },
      setZaiRuntimeMode: async (mode) => {
        if (mode !== 'headless' && mode !== 'visible') {
          throw new Error(`Unsupported z.ai runtime mode: ${mode}`);
        }
        await vscode.workspace
          .getConfiguration('webagentCode')
          .update('zai.runtimeMode', mode, vscode.ConfigurationTarget.Workspace);
      },
      previewSessionChanges: async (sessionId) => {
        const session = sessions.get(sessionId);
        if (!session) {
          throw new Error('Session not found.');
        }

        const modifiedActions = session.actionHistory.filter(
          (action) =>
            action.status === 'done' &&
            ['edit_file', 'create_file', 'delete_file', 'rename_file'].includes(action.type),
        );

        if (!modifiedActions.length) {
          await vscode.window.showInformationMessage('No code modifications recorded for this session.');
          return;
        }

        const gitDiff = await git.getDiff().catch(() => 'No diff');
        const actionSummaries = modifiedActions.map((action) =>
          [action.summary || action.type, action.preview ? `(${action.preview.split('\n')[0]})` : ''].filter(Boolean).join(' '),
        );
        await diffPreview.showSessionChangePreview(session.task || 'Chat session', actionSummaries, gitDiff);
      },
    };

  const panel = new WebAgentPanel(
    context.extensionUri,
    sessions,
    providers,
    () => safety.approvalMode,
    panelCallbacks,
  );

  const sessionTreeProvider = new SessionTreeProvider(sessions);
  const activityTreeProvider = new ActivityTreeProvider(sessions);
  const bridgeTreeProvider = new BridgeTreeProvider(bridgeCompanion, providers, sessions, getBridgeState);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('webagentCode.sessions', sessionTreeProvider),
    vscode.window.registerTreeDataProvider('webagentCode.activity', activityTreeProvider),
    vscode.window.registerTreeDataProvider('webagentCode.bridge', bridgeTreeProvider),
    vscode.commands.registerCommand('webagentCode.open', () => panel.show()),
    vscode.commands.registerCommand('webagentCode.startTask', async () => {
      panel.show();
      const providerId = (await vscode.window.showQuickPick(providers.list(), {
        placeHolder: 'Choose a provider',
      })) as ProviderId | undefined;
      if (!providerId) {
        return;
      }
      const task = await vscode.window.showInputBox({ placeHolder: 'Describe the coding task' });
      if (!task?.trim()) {
        return;
      }
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const session = sessions.create(providerId, task, workspaceRoot);
      await ensureBridgeCompanion(providerId, session.id);
      void orchestrator.start(session.id, providerId, task);
    }),
    vscode.commands.registerCommand('webagentCode.stopTask', () => {
      const active = sessions.getActive();
      if (!active) {
        return;
      }
      orchestrator.stop(active.id);
      sessions.setStatus(active.id, 'stopped');
    }),
    vscode.commands.registerCommand('webagentCode.loginProvider', async () => {
      const providerId = (await vscode.window.showQuickPick(providers.list(), {
        placeHolder: 'Choose a provider to log into',
      })) as ProviderId | undefined;
      if (!providerId) {
        return;
      }
      await ensureBridgeCompanion(providerId);
      await providers.get(providerId).login();
    }),
    vscode.commands.registerCommand('webagentCode.resetConversation', async () => {
      const providerId = (await vscode.window.showQuickPick(providers.list(), {
        placeHolder: 'Choose a provider to reset',
      })) as ProviderId | undefined;
      if (!providerId) {
        return;
      }
      await ensureBridgeCompanion(providerId);
      await providers.get(providerId).resetConversation();
    }),
    vscode.commands.registerCommand('webagentCode.startBridgeCompanion', async () => {
      await bridgeCompanion.ensureRunning('manual');
      bridgeCompanion.showLogs(true);
      await vscode.window.showInformationMessage('Bridge companion start requested.');
    }),
    vscode.commands.registerCommand('webagentCode.stopBridgeCompanion', async () => {
      await bridgeCompanion.stopOwnedProcess();
      await vscode.window.showInformationMessage('Stopped owned bridge companion process.');
    }),
    vscode.commands.registerCommand('webagentCode.restartBridgeCompanion', async () => {
      await bridgeCompanion.restartOwnedProcess();
      bridgeCompanion.showLogs(true);
      await vscode.window.showInformationMessage('Bridge companion restarted.');
    }),
    vscode.commands.registerCommand('webagentCode.approvePendingAction', () => {
      const active = sessions.getActive();
      const approval = active?.approvalRequest;
      if (!approval) {
        return;
      }
      approvals.approve(approval.actionId);
    }),
    vscode.commands.registerCommand('webagentCode.rejectPendingAction', () => {
      const active = sessions.getActive();
      const approval = active?.approvalRequest;
      if (!approval) {
        return;
      }
      approvals.reject(approval.actionId);
    }),
  );

  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  const refresh = () => {
    sessionTreeProvider.refresh();
    activityTreeProvider.refresh();
  };
  watcher.onDidCreate(refresh, undefined, context.subscriptions);
  watcher.onDidChange(refresh, undefined, context.subscriptions);
  watcher.onDidDelete(refresh, undefined, context.subscriptions);
  context.subscriptions.push(watcher);

  panel.show();
}

export function deactivate(): void {
  // No-op for now.
}
