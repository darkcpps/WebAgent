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
import type { ApprovalMode, BridgeUiState, ProviderId } from './shared/types';
import type { ProviderAdapter, ProviderPrompt } from './providers/base';
import { AgentResponseParser } from './agent/parser';
import { buildProviderPrompt } from './agent/planner';
import { sanitizeResponse } from './shared/utils';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const AUTO_FOLLOW_UP_DELAY_MS = 3000;
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
  const workspaceContext = new WorkspaceContextService(files, git);
  const executor = new ActionExecutor(files, git, safety, approvals, sessions, diffPreview, terminal);
  const orchestrator = new AgentOrchestrator(providers, workspaceContext, executor, sessions);
  const parser = new AgentResponseParser();
  const providerReady: Record<ProviderId, boolean> = {
    chatgpt: false,
    gemini: false,
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

  const buildChatAskPrompt = (userPrompt: string, options: { wasPreviouslyAgentMode: boolean }): ProviderPrompt => {
    const systemLines = [
      'You are in Chat/Ask mode inside an IDE conversation.',
      'Respond conversationally and helpfully to the user question.',
      'Do not output tool-action JSON and do not behave as an autonomous agent in this mode.',
      'Explain code changes clearly when asked, and ask clarifying questions if context is missing.',
      options.wasPreviouslyAgentMode
        ? 'Important: Previous agent-mode instructions in this thread are inactive. Ignore them unless the user explicitly asks to enable Agent Mode again.'
        : 'Stay in Chat/Ask mode unless the user explicitly asks to switch to Agent Mode.',
    ];

    return {
      systemPrompt: systemLines.join('\n'),
      userPrompt,
    };
  };

  const appendPromptPreviewLog = (
    sessionId: string,
    mode: 'chat' | 'agent',
    prompt: ProviderPrompt,
    round?: number,
  ): void => {
    const label = mode === 'chat' ? 'Chat/Ask' : round ? `Agent (round ${round})` : 'Agent';
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

  const panel = new WebAgentPanel(
    context.extensionUri,
    sessions,
    providers,
    () => safety.approvalMode,
    {
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
      sendChat: async (providerId, message, modelId, sessionId, agentMode) => {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const existing = sessionId ? sessions.get(sessionId) : undefined;
        const wasEmptySession = (existing?.chatHistory.length ?? 0) === 0;
        const session =
          existing && existing.providerId === providerId ? existing : sessions.create(providerId, 'Chat session', workspaceRoot);

        sessions.setActive(session.id);
        sessions.appendChatMessage(session.id, {
          role: 'user',
          content: message,
          modelId,
        });
        const assistantMessage = sessions.appendChatMessage(session.id, {
          role: 'assistant',
          content: 'Thinking...',
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

          // Model selection (non-fatal)
          if (modelId && modelId !== 'auto') {
            const selected = await runWithAutoFallback(() => provider.selectModel(modelId), 'selectModel').catch(() => false);
            if (!selected) {
              sessions.appendLog(session.id, {
                level: 'warning',
                source: 'provider',
                message: `Could not select model ${modelId}. Proceeding with default.`,
              });
            } else {
              const selectedModelLabel =
                provider.listModels().find((entry) => entry.id === modelId)?.label || modelId;
              sessions.appendLog(session.id, {
                level: 'info',
                source: 'provider',
                message:
                  providerId === 'zai'
                    ? `Model selected: ${selectedModelLabel} (${modelId}). Request payload override armed for /api/v1/chats/new and /api/v2/chat/completions.`
                    : `Model selected: ${selectedModelLabel} (${modelId})`,
              });
            }
          }

          const trimmedMessage = message.trim();
          const useAgentTools = Boolean(agentMode) || /^\/agent\s+/i.test(trimmedMessage);
          const chatPrompt = /^\/agent\s+/i.test(trimmedMessage) ? trimmedMessage.replace(/^\/agent\s+/i, '').trim() : trimmedMessage;
          const wasPreviouslyAgentMode = sessions.get(session.id)?.lastPromptMode === 'agent';
          sessions.update(session.id, { lastPromptMode: useAgentTools ? 'agent' : 'chat' });
          if (!chatPrompt) {
            throw new Error('Empty message.');
          }

          if (!useAgentTools) {
            const prompt = buildChatAskPrompt(chatPrompt, { wasPreviouslyAgentMode });
            appendPromptPreviewLog(session.id, 'chat', prompt);
            await runWithAutoFallback(() => provider.sendPrompt(prompt), 'sendPrompt(chat)');

            const responseText = await runWithAutoFallback(
              () =>
                collectProviderText(session.id, providerId, (delta) => {
                  if (assistantMessage) {
                    sessions.updateChatMessage(session.id, assistantMessage.id, {
                      content: sanitizeResponse(delta) || 'Thinking...',
                      rawContent: delta,
                    });
                  }
                }),
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


          const repoContext = await workspaceContext.build(chatPrompt);
          const toolResults: string[] = [];
          let finalText = '';
          let lastRawResponse = '';
          const actionUpdates: string[] = [];
          let executedActionCount = 0;
          let failedActionCount = 0;
          let endedByAskUser = false;
          let invalidToolResponseCount = 0;
          let autoCorrectionCount = 0;

          const compact = (value: string, limit = 220): string => {
            const normalized = value.replace(/\s+/g, ' ').trim();
            if (normalized.length <= limit) {
              return normalized;
            }
            return `${normalized.slice(0, limit)}...`;
          };

          const pushActionUpdate = (line: string): void => {
            actionUpdates.push(line);
            if (actionUpdates.length > 20) {
              actionUpdates.shift();
            }

            if (assistantMessage) {
              sessions.updateChatMessage(session.id, assistantMessage.id, {
                content: 'Working...',
                rawContent: lastRawResponse || 'Working...',
              });
            }
          };

          const trimForToolPrompt = (actionType: string, value: string): string => {
            const limitByAction: Record<string, number> = {
              read_file: 14000,
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
            await runWithAutoFallback(() => provider.sendPrompt(prompt), `sendPrompt(agent round ${round + 1})`);

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
                      'Respond ONLY with this exact shape:',
                      '{"summary":"...","actions":[{"type":"list_files|read_file|search_files|edit_file|create_file|delete_file|rename_file|run_command|get_git_diff|ask_user|finish", ...}]}',
                      'Use only allowed tool names. Do not include prose outside JSON. If uncertain, use read_file/search_files first.',
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
              pushActionUpdate(`AI plan: ${compact(parsed.summary, 160)}`);
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

              const result = await executor.execute(session.id, action);
              executedActionCount += 1;
              if (/^(Action failed:|Blocked action )/i.test(result.message.trim())) {
                failedActionCount += 1;
              }
              toolResults.push(`${action.type}: ${trimForToolPrompt(action.type, result.message)}`);
              if (toolResults.length > 10) {
                toolResults.shift();
              }
              const summaryLabel = action.summary?.trim();
              const label = summaryLabel && summaryLabel.length > 0 ? `${action.type} (${summaryLabel})` : action.type;
              pushActionUpdate(`${label} -> ${compact(result.message)}`);
              finalText = result.message;

              if (/^(Action failed:|Blocked action )/i.test(result.message.trim())) {
                if (autoCorrectionCount < 4) {
                  autoCorrectionCount += 1;
                  toolResults.push(
                    [
                      'SYSTEM_FEEDBACK: The previous action failed or was blocked in IDE execution.',
                      `Failure detail: ${result.message}`,
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
            const outcome = finalText ? compact(finalText, 300) : '';
            const recentUpdates = actionUpdates.slice(-6);
            finalText = [
              completionLine,
              ...(failureLine ? [failureLine] : []),
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
              rawContent: lastRawResponse || finalText || '',
            });
          }
          sessions.setStatus(session.id, 'done');
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
      stopTask: async (sessionId) => {
        orchestrator.stop(sessionId);
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
        await providers.get(providerId).refreshModels();
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
    },
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
