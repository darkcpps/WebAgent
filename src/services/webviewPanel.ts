import * as vscode from 'vscode';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../shared/messages';
import type { ApprovalMode, BridgeUiState, ProviderId, ProviderModelRefreshStatus, ZaiManagedMode } from '../shared/types';
import type { ProviderReadiness } from '../providers/base';
import type { ProviderRegistry } from '../providers/registry';
import type { SessionStore } from '../storage/sessionStore';
import { getWebviewHtml } from '../webview/getHtml';

interface PanelCallbacks {
  newChat(providerId: ProviderId): Promise<void>;
  deleteChat(sessionId: string): Promise<void>;
  startTask(providerId: ProviderId, task: string): Promise<void>;
  sendChat(
    providerId: ProviderId,
    message: string,
    modelId?: string,
    sessionId?: string,
    agentMode?: boolean,
    planningMode?: boolean,
    enableThinking?: boolean,
  ): Promise<void>;
  regenerateChatInNewSession(
    providerId: ProviderId,
    sourceSessionId: string,
    message: string,
    modelId?: string,
    agentMode?: boolean,
    planningMode?: boolean,
    enableThinking?: boolean,
  ): Promise<void>;
  stopTask(sessionId: string): Promise<void>;
  loginProvider(providerId: ProviderId): Promise<void>;
  logoutProvider(providerId: ProviderId): Promise<boolean>;
  checkProviderReady(providerId: ProviderId): Promise<ProviderReadiness>;
  refreshProviderModels(providerId: ProviderId): Promise<number>;
  resetConversation(providerId: ProviderId): Promise<void>;
  approve(sessionId: string, actionId: string): Promise<void>;
  reject(sessionId: string, actionId: string): Promise<void>;
  setActiveSession(sessionId: string): void;
  getProviderReadyState(): Record<ProviderId, boolean>;
  getBridgeState(): Promise<BridgeUiState>;
  startBridgeCompanion(): Promise<void>;
  stopBridgeCompanion(): Promise<void>;
  restartBridgeCompanion(): Promise<void>;
  openBridgeExtensionFolder(): Promise<void>;
  openZaiInBrowser(): Promise<void>;
  setApprovalMode(mode: ApprovalMode): Promise<void>;
  setZaiRuntimeMode(mode: ZaiManagedMode): Promise<void>;
  previewSessionChanges(sessionId: string): Promise<void>;
}

export class WebAgentPanel {
  private static readonly MODEL_REFRESH_TIMEOUT_MS = 12000;
  private static readonly PERPLEXITY_MODEL_REFRESH_TIMEOUT_MS = 15000;
  private static readonly MODEL_REFRESH_COOLDOWN_MS = 30000;
  private static readonly PERPLEXITY_MODEL_RETRY_DELAYS_MS = [1000, 3000, 7000];
  private panel?: vscode.WebviewPanel;
  private readonly readyToastShown = new Set<ProviderId>();
  private lastBridgeState?: BridgeUiState;
  private bridgeRefreshInProgress = false;
  private readonly modelRefreshInFlight = new Map<ProviderId, Promise<void>>();
  private readonly lastModelRefreshAt = new Map<ProviderId, number>();
  private readonly modelRefreshStatus = new Map<ProviderId, ProviderModelRefreshStatus>();
  private readonly modelRefreshRetryTimer = new Map<ProviderId, ReturnType<typeof setTimeout>>();
  private readonly perplexityRetryAttempt = new Map<ProviderId, number>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly sessions: SessionStore,
    private readonly providers: ProviderRegistry,
    private readonly approvalMode: () => ApprovalMode,
    private readonly callbacks: PanelCallbacks,
  ) {
    const defaultStatus: ProviderModelRefreshStatus = { status: 'idle' };
    this.modelRefreshStatus.set('chatgpt', defaultStatus);
    this.modelRefreshStatus.set('gemini', defaultStatus);
    this.modelRefreshStatus.set('perplexity', defaultStatus);
    this.modelRefreshStatus.set('zai', defaultStatus);
    this.sessions.onDidChange(() => {
      // Post core state immediately to keep UI snappy
      void this.postState(false);
    });
  }

  show(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      void this.postState();
      return;
    }

    this.panel = vscode.window.createWebviewPanel('webagentCode', 'WebAgent Code', vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [this.extensionUri],
    });

    this.panel.webview.html = getWebviewHtml(this.panel.webview, this.extensionUri);
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    this.panel.webview.onDidReceiveMessage((message: WebviewToExtensionMessage) => {
      void this.handleMessage(message);
    });

    void this.postState();
  }

  private async handleMessage(message: WebviewToExtensionMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
        case 'refreshState':
          await this.postState();
          return;
        case 'newChat':
          await this.callbacks.newChat(message.providerId);
          await this.postToast('info', `Started new ${message.providerId} chat.`);
          return;
        case 'deleteChat':
          await this.callbacks.deleteChat(message.sessionId);
          await this.postToast('info', 'Deleted chat.');
          return;
        case 'startTask':
          await this.callbacks.startTask(message.providerId, message.task);
          await this.postToast('info', `Started task with ${message.providerId}.`);
          return;
        case 'sendChat':
          await this.callbacks.sendChat(
            message.providerId,
            message.message,
            message.modelId,
            message.sessionId,
            message.agentMode,
            message.planningMode,
            message.enableThinking,
          );
          return;
        case 'regenerateChatInNewSession':
          await this.callbacks.regenerateChatInNewSession(
            message.providerId,
            message.sourceSessionId,
            message.message,
            message.modelId,
            message.agentMode,
            message.planningMode,
            message.enableThinking,
          );
          await this.postToast('info', 'Regenerated prompt in a new chat.');
          return;
        case 'stopTask':
          await this.callbacks.stopTask(message.sessionId);
          await this.postToast('warning', 'Stopped active task.');
          return;
        case 'loginProvider':
          await this.callbacks.loginProvider(message.providerId);
          await this.callbacks.checkProviderReady(message.providerId);
          await this.postState();
          if (message.providerId !== 'perplexity') {
            void this.refreshProviderModelsInBackground(message.providerId, { force: true });
          }
          await this.postToast('success', `Opened ${message.providerId} login page. Complete sign-in in browser.`);
          return;
        case 'logoutProvider': {
          const loggedOut = await this.callbacks.logoutProvider(message.providerId);
          await this.postState();
          await this.postToast(loggedOut ? 'info' : 'warning', loggedOut ? 'Signed out.' : 'Could not find sign out button.');
          return;
        }
        case 'checkProviderReady': {
          const readiness = await this.callbacks.checkProviderReady(message.providerId);
          await this.postState();
          const isSilentHeartbeat = Boolean(message.silent);
          const shouldRefreshModels = message.providerId !== 'perplexity' && readiness.ready;
          if (shouldRefreshModels) {
            const currentModelCount = this.getCurrentModelCount(message.providerId);
            const hasRefreshedBefore = this.lastModelRefreshAt.has(message.providerId);
            const force = currentModelCount <= 1 && !hasRefreshedBefore;
            void this.refreshProviderModelsInBackground(message.providerId, { force, reason: 'provider-ready' });
          }
          if (!message.silent) {
            if (readiness.ready) {
              if (!this.readyToastShown.has(message.providerId)) {
                this.readyToastShown.add(message.providerId);
                await this.postToast('success', `${message.providerId} is ready. You can start a task now.`);
              }
            } else {
              await this.postToast(
                'warning',
                readiness.loginRequired
                  ? `${message.providerId} is signed out. Click Login to continue.`
                  : `${message.providerId} is not ready yet. Finish login, then check again.`,
              );
            }
          }
          return;
        }
        case 'refreshProviderModels':
          void this.refreshProviderModelsInBackground(message.providerId, { force: true, reason: 'manual' });
          return;
        case 'resetConversation':
          await this.callbacks.resetConversation(message.providerId);
          await this.postToast('info', `Reset conversation for ${message.providerId}.`);
          return;
        case 'approve':
          await this.callbacks.approve(message.sessionId, message.actionId);
          await this.postToast('success', 'Action approved.');
          return;
        case 'reject':
          await this.callbacks.reject(message.sessionId, message.actionId);
          await this.postToast('warning', 'Action rejected.');
          return;
        case 'setActiveSession':
          this.callbacks.setActiveSession(message.sessionId);
          await this.postState();
          return;
        case 'refreshBridgeStatus':
          await this.postState();
          return;
        case 'startBridgeCompanion':
          await this.callbacks.startBridgeCompanion();
          await this.postState();
          await this.postToast('success', 'Bridge companion start requested.');
          return;
        case 'stopBridgeCompanion':
          await this.callbacks.stopBridgeCompanion();
          await this.postState();
          await this.postToast('warning', 'Bridge companion stop requested.');
          return;
        case 'restartBridgeCompanion':
          await this.callbacks.restartBridgeCompanion();
          await this.postState();
          await this.postToast('info', 'Bridge companion restart requested.');
          return;
        case 'openBridgeExtensionFolder':
          await this.callbacks.openBridgeExtensionFolder();
          return;
        case 'openZaiInBrowser':
          await this.callbacks.openZaiInBrowser();
          return;
        case 'setApprovalMode':
          await this.callbacks.setApprovalMode(message.mode);
          await this.postState();
          await this.postToast('success', `Approval mode set to ${message.mode}.`);
          return;
        case 'setZaiRuntimeMode':
          await this.callbacks.setZaiRuntimeMode(message.mode);
          await this.postState();
          await this.postToast('info', `z.ai managed runtime set to ${message.mode}.`);
          return;
        case 'previewSessionChanges':
          await this.callbacks.previewSessionChanges(message.sessionId);
          return;
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      await this.postToast('error', messageText);
      void vscode.window.showErrorMessage(messageText);
    }
  }

  private async postState(refreshBridge = true): Promise<void> {
    if (!this.panel) {
      return;
    }

    // Use cached bridge state if available and not refreshing
    if (refreshBridge && !this.bridgeRefreshInProgress) {
      this.bridgeRefreshInProgress = true;
      try {
        this.lastBridgeState = await this.callbacks.getBridgeState();
      } catch (error) {
        this.lastBridgeState = {
          transport: 'auto' as const,
          activeRuntime: 'playwright' as const,
          managedMode: 'headless' as const,
          autoStartCompanion: false,
          companionReachable: false,
          companionOwnedByExtension: false,
          browserConnected: false,
          ready: false,
          loginRequired: false,
          lastError: error instanceof Error ? error.message : 'Could not load bridge state.',
        };
      } finally {
        this.bridgeRefreshInProgress = false;
      }
    }

    const bridge = this.lastBridgeState ?? {
      transport: 'auto' as const,
      activeRuntime: 'playwright' as const,
      managedMode: 'headless' as const,
      autoStartCompanion: false,
      companionReachable: false,
      companionOwnedByExtension: false,
      browserConnected: false,
      ready: false,
      loginRequired: false,
    };

    const payload: ExtensionToWebviewMessage = {
      type: 'state',
      state: {
        sessions: this.sessions.getAll(),
        activeSessionId: this.sessions.getActive()?.id,
        providers: this.providers.list(),
        providerModels: {
          chatgpt: this.providers.get('chatgpt').listModels(),
          gemini: this.providers.get('gemini').listModels(),
          perplexity: this.providers.get('perplexity').listModels(),
          zai: this.providers.get('zai', { sessionId: this.sessions.getActive()?.id }).listModels(),
        },
        modelRefreshStatus: this.getModelRefreshStatusSnapshot(),
        providerReady: this.callbacks.getProviderReadyState(),
        approvalMode: this.approvalMode(),
        bridge,
      },
    };
    await this.panel.webview.postMessage(payload);
  }

  private async postToast(
    level: 'info' | 'warning' | 'error' | 'success',
    message: string,
  ): Promise<void> {
    if (!this.panel) {
      return;
    }
    const payload: ExtensionToWebviewMessage = {
      type: 'toast',
      level,
      message,
    };
    await this.panel.webview.postMessage(payload);
  }

  private getCurrentModelCount(providerId: ProviderId): number {
    const sessionId = this.sessions.getActive()?.id;
    return this.providers.get(providerId, { sessionId }).listModels().length;
  }

  private refreshProviderModelsInBackground(providerId: ProviderId, options?: { force?: boolean; reason?: string }): Promise<void> {
    const existing = this.modelRefreshInFlight.get(providerId);
    if (existing) {
      return existing;
    }

    const isPerplexity = providerId === 'perplexity';
    const now = Date.now();
    const lastRefresh = this.lastModelRefreshAt.get(providerId) ?? 0;
    if (!options?.force && now - lastRefresh < WebAgentPanel.MODEL_REFRESH_COOLDOWN_MS) {
      return Promise.resolve();
    }

    if (isPerplexity && options?.reason !== 'retry' && options?.force) {
      this.clearRefreshRetry(providerId);
      this.perplexityRetryAttempt.set(providerId, 0);
    }

    const task = (async () => {
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      try {
        this.setModelRefreshStatus(providerId, {
          status: 'loading',
          message: isPerplexity ? 'Refreshing Perplexity models...' : 'Refreshing models...',
        });

        const refreshPromise = this.callbacks.refreshProviderModels(providerId);
        if (isPerplexity) {
          void refreshPromise
            .then(async (count) => {
              if (!timedOut) {
                return;
              }
              this.lastModelRefreshAt.set(providerId, Date.now());
              this.setModelRefreshStatus(providerId, {
                status: 'success',
                message: count > 1 ? `Loaded ${count - 1} model(s).` : 'Only Auto found. Retry scheduled.',
              });
              await this.postState(false);
              this.handlePerplexityRetry(count);
            })
            .catch(async (error) => {
              if (!timedOut) {
                return;
              }
              const message = error instanceof Error ? error.message : String(error);
              this.setModelRefreshStatus(providerId, {
                status: 'error',
                message: `Late refresh failed: ${message}`,
              });
              await this.postState(false);
            });
        }

        const timeoutMs = isPerplexity
          ? WebAgentPanel.PERPLEXITY_MODEL_REFRESH_TIMEOUT_MS
          : WebAgentPanel.MODEL_REFRESH_TIMEOUT_MS;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error(`Model refresh timed out after ${Math.round(timeoutMs / 1000)}s.`)), timeoutMs);
        });
        const modelCount = await Promise.race([refreshPromise, timeoutPromise]);
        this.lastModelRefreshAt.set(providerId, Date.now());
        this.setModelRefreshStatus(providerId, {
          status: 'success',
          message: modelCount > 1 ? `Loaded ${modelCount - 1} model(s).` : 'Only Auto found. Retry scheduled.',
        });
        await this.postState(false);
        if (isPerplexity) {
          this.handlePerplexityRetry(modelCount);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[webagent] Model refresh failed for ${providerId}: ${message}`);
        if (/timed out/i.test(message)) {
          timedOut = true;
        }
        this.setModelRefreshStatus(providerId, {
          status: 'error',
          message: isPerplexity && /timed out/i.test(message) ? 'Refresh timed out. Retrying...' : message,
        });
        await this.postState(false);
        if (isPerplexity && /timed out/i.test(message)) {
          this.handlePerplexityRetry(1);
        }
      } finally {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        this.modelRefreshInFlight.delete(providerId);
      }
    })();

    this.modelRefreshInFlight.set(providerId, task);
    return task;
  }

  private handlePerplexityRetry(modelCount: number): void {
    const providerId: ProviderId = 'perplexity';
    if (modelCount > 1) {
      this.clearRefreshRetry(providerId);
      this.perplexityRetryAttempt.set(providerId, 0);
      return;
    }

    const attempt = this.perplexityRetryAttempt.get(providerId) ?? 0;
    if (attempt >= WebAgentPanel.PERPLEXITY_MODEL_RETRY_DELAYS_MS.length) {
      return;
    }

    this.clearRefreshRetry(providerId);
    const delayMs = WebAgentPanel.PERPLEXITY_MODEL_RETRY_DELAYS_MS[attempt];
    this.perplexityRetryAttempt.set(providerId, attempt + 1);
    this.setModelRefreshStatus(providerId, {
      status: 'loading',
      message: `Only Auto found. Retrying in ${Math.round(delayMs / 1000)}s...`,
    });
    const timer = setTimeout(() => {
      this.modelRefreshRetryTimer.delete(providerId);
      void this.refreshProviderModelsInBackground(providerId, { force: true, reason: 'retry' });
    }, delayMs);
    this.modelRefreshRetryTimer.set(providerId, timer);
  }

  private clearRefreshRetry(providerId: ProviderId): void {
    const timer = this.modelRefreshRetryTimer.get(providerId);
    if (timer) {
      clearTimeout(timer);
      this.modelRefreshRetryTimer.delete(providerId);
    }
  }

  private setModelRefreshStatus(providerId: ProviderId, status: ProviderModelRefreshStatus): void {
    this.modelRefreshStatus.set(providerId, {
      ...status,
      lastUpdated: Date.now(),
    });
  }

  private getModelRefreshStatusSnapshot(): Record<ProviderId, ProviderModelRefreshStatus> {
    return {
      chatgpt: this.modelRefreshStatus.get('chatgpt') ?? { status: 'idle' },
      gemini: this.modelRefreshStatus.get('gemini') ?? { status: 'idle' },
      perplexity: this.modelRefreshStatus.get('perplexity') ?? { status: 'idle' },
      zai: this.modelRefreshStatus.get('zai') ?? { status: 'idle' },
    };
  }
}
