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
import type { BridgeUiState, ProviderId } from './shared/types';
import { AgentResponseParser } from './agent/parser';
import { buildProviderPrompt } from './agent/planner';
import { sanitizeResponse } from './shared/utils';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
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

  const maybeOfferZaiPlaywrightFallback = async (sessionId: string, error: unknown): Promise<void> => {
    if (providers.getZaiTransport(sessionId) !== 'bridge') {
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    if (!/\[bridge\]|companion|z\.ai bridge|socket/i.test(message)) {
      return;
    }

    const picked = await vscode.window.showWarningMessage(
      'z.ai bridge is unavailable for this chat. Switch this session to Playwright fallback?',
      'Switch to Playwright',
      'Keep Bridge',
    );

    if (picked !== 'Switch to Playwright') {
      return;
    }

    providers.setZaiSessionTransport(sessionId, 'playwright');
    sessions.appendLog(sessionId, {
      level: 'warning',
      source: 'provider',
      message: 'Switched this z.ai session to Playwright fallback.',
    });
    const readiness = await providers.get('zai', { sessionId }).checkReady().catch(() => ({ ready: false }));
    providerReady.zai = Boolean(readiness.ready);
  };

  const getBridgeState = async (): Promise<BridgeUiState> => {
    const activeSessionId = sessions.getActive()?.id;
    const transport = providers.getZaiTransport(activeSessionId);
    const autoStartCompanion = vscode.workspace.getConfiguration('webagentCode').get<boolean>('bridge.autoStartCompanion', true);
    const companionReachable = await bridgeCompanion.isReachable().catch(() => false);

    let browserConnected = false;
    let ready = false;
    let loginRequired = false;
    let lastError: string | undefined;

    if (transport === 'bridge') {
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
    }

    return {
      transport,
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
        if (session.providerSessionId) {
          await providers.get(session.providerId, { sessionId }).deleteConversation(session.providerSessionId).catch(() => undefined);
        }
        if (sessions.getActive()?.id === sessionId) {
          await providers.get(session.providerId, { sessionId }).resetConversation().catch(() => undefined);
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
          const provider = providers.get(providerId, { sessionId: session.id });

          // Only perform heavy readiness checks if we haven't checked recently or it's a new provider
          if (!providerReady[providerId] || !existing) {
            await companionPromise;
            const readiness = await provider.checkReady();
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
          const browserConversationId = await provider.getCurrentConversationId().catch(() => undefined);
          const sessionConversationId = sessions.get(session.id)?.providerSessionId;

          // Step 2: Only navigate if we MUST switch to a different conversation.
          // If the session has a stored conversation ID and the browser is on a DIFFERENT one, navigate.
          if (sessionConversationId && browserConversationId !== sessionConversationId) {
            sessions.appendLog(session.id, {
              level: 'info',
              source: 'agent',
              message: `Switching browser to conversation ${sessionConversationId}...`,
            });
            await provider.openConversation(sessionConversationId).catch(() => false);
          }
          // If the session has NO stored ID, just use whatever page is currently open.
          // The browser is either on the home page (new chat) or an existing conversation.
          // Either way, we just type into it. No startNewConversation() call needed.
          // If the browser happens to be on an existing conversation and we don't have an ID yet, adopt it.
          if (!sessionConversationId && browserConversationId) {
            sessions.setProviderSessionId(session.id, browserConversationId);
          }

          // Model selection (non-fatal)
          if (modelId && modelId !== 'auto') {
            const selected = await provider.selectModel(modelId).catch(() => false);
            if (!selected) {
              sessions.appendLog(session.id, {
                level: 'warning',
                source: 'provider',
                message: `Could not select model ${modelId}. Proceeding with default.`,
              });
            } else {
              sessions.appendLog(session.id, {
                level: 'info',
                source: 'provider',
                message: `Model selected: ${modelId}`,
              });
            }
          }

          const trimmedMessage = message.trim();
          const useAgentTools = Boolean(agentMode) || /^\/agent\s+/i.test(trimmedMessage);
          const chatPrompt = /^\/agent\s+/i.test(trimmedMessage) ? trimmedMessage.replace(/^\/agent\s+/i, '').trim() : trimmedMessage;
          if (!chatPrompt) {
            throw new Error('Empty message.');
          }

          if (!useAgentTools) {
            await provider.sendPrompt({
              systemPrompt: '',
              userPrompt: chatPrompt,
            });

            const responseText = await collectProviderText(session.id, providerId, (delta) => {
              if (assistantMessage) {
                sessions.updateChatMessage(session.id, assistantMessage.id, {
                  content: sanitizeResponse(delta) || 'Thinking...',
                  rawContent: delta,
                });
              }
            });
            const cleaned = cleanFinalResponse(responseText);
            sessions.appendRawResponse(session.id, cleaned);
            if (assistantMessage) {
              sessions.updateChatMessage(session.id, assistantMessage.id, {
                content: cleaned,
                rawContent: responseText,
              });
            }
            // Always capture the browser URL after the response and lock it to this session.
            // Z.ai creates the /c/UUID path during response generation.
            await new Promise((r) => setTimeout(r, 1500));
            const conversationId = await provider.getCurrentConversationId().catch(() => undefined);
            if (conversationId) {
              sessions.setProviderSessionId(session.id, conversationId);
              sessions.appendLog(session.id, {
                level: 'info',
                source: 'agent',
                message: `Session locked to conversation: ${conversationId}`,
              });
            }
            sessions.setStatus(session.id, 'done');
            return;
          }


          const repoContext = await workspaceContext.build(chatPrompt);
          const toolResults: string[] = [];
          let finalText = '';
          let lastRawResponse = '';

          for (let round = 0; round < 5; round += 1) {
            const prompt = buildProviderPrompt(chatPrompt, repoContext, toolResults);
            await provider.sendPrompt(prompt);
            
            const responseText = await collectProviderText(session.id, providerId, (delta) => {
              if (assistantMessage) {
                // Show human-readable preview during streaming, not raw JSON
                const preview = sanitizeResponse(delta) || 'Thinking...';
                sessions.updateChatMessage(session.id, assistantMessage.id, {
                  content: preview,
                  rawContent: delta,
                });
              }
            });
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
                finalText = cleanFinalResponse(responseText);
                sessions.appendLog(session.id, {
                  level: 'warning',
                  source: 'agent',
                  message: `Could not parse tool JSON in round ${round + 1}: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
                });
                break;
              }
            }

            if (parsed.summary) {
              sessions.appendLog(session.id, { level: 'info', source: 'provider', message: parsed.summary });
            }

            for (const action of parsed.actions) {
              const result = await executor.execute(session.id, action);
              toolResults.push(`${action.type}: ${result.message}`);
              finalText = result.message;

              if (action.type === 'ask_user' || action.type === 'finish' || result.done) {
                finalText = result.message;
                round = 99;
                break;
              }
            }
          }

          if (assistantMessage) {
            sessions.updateChatMessage(session.id, assistantMessage.id, {
              content: finalText || 'Done.',
              rawContent: lastRawResponse || finalText || '',
            });
          }
          const conversationId = await provider.getCurrentConversationId().catch(() => undefined);
          if (conversationId) {
            sessions.setProviderSessionId(session.id, conversationId);
            sessions.appendLog(session.id, {
              level: 'info',
              source: 'agent',
              message: `Session locked to conversation: ${conversationId}`,
            });
          }
          sessions.setStatus(session.id, 'done');
        } catch (error) {
          if (assistantMessage) {
            sessions.updateChatMessage(session.id, assistantMessage.id, {
              content: error instanceof Error ? `Error: ${error.message}` : `Error: ${String(error)}`,
            });
          }
          if (providerId === 'zai') {
            await maybeOfferZaiPlaywrightFallback(session.id, error);
          }
          sessions.setStatus(session.id, 'error');
          sessions.appendLog(session.id, {
            level: 'error',
            source: 'agent',
            message: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },
      stopTask: async (sessionId) => {
        orchestrator.stop(sessionId);
        sessions.setStatus(sessionId, 'stopped');
      },
      loginProvider: async (providerId) => {
        await ensureBridgeCompanion(providerId);
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
