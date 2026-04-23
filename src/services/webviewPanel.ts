import * as vscode from 'vscode';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../shared/messages';
import type { ApprovalMode, BridgeUiState, ProviderId, ZaiManagedMode } from '../shared/types';
import type { ProviderReadiness } from '../providers/base';
import type { ProviderRegistry } from '../providers/registry';
import type { SessionStore } from '../storage/sessionStore';
import { getWebviewHtml } from '../webview/getHtml';

interface PanelCallbacks {
  newChat(providerId: ProviderId): Promise<void>;
  deleteChat(sessionId: string): Promise<void>;
  startTask(providerId: ProviderId, task: string): Promise<void>;
  sendChat(providerId: ProviderId, message: string, modelId?: string, sessionId?: string, agentMode?: boolean): Promise<void>;
  stopTask(sessionId: string): Promise<void>;
  loginProvider(providerId: ProviderId): Promise<void>;
  logoutProvider(providerId: ProviderId): Promise<boolean>;
  checkProviderReady(providerId: ProviderId): Promise<ProviderReadiness>;
  refreshProviderModels(providerId: ProviderId): Promise<void>;
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
  private panel?: vscode.WebviewPanel;
  private readonly readyToastShown = new Set<ProviderId>();
  private lastBridgeState?: BridgeUiState;
  private bridgeRefreshInProgress = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly sessions: SessionStore,
    private readonly providers: ProviderRegistry,
    private readonly approvalMode: () => ApprovalMode,
    private readonly callbacks: PanelCallbacks,
  ) {
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
          await this.callbacks.sendChat(message.providerId, message.message, message.modelId, message.sessionId, message.agentMode);
          return;
        case 'stopTask':
          await this.callbacks.stopTask(message.sessionId);
          await this.postToast('warning', 'Stopped active task.');
          return;
        case 'loginProvider':
          await this.callbacks.loginProvider(message.providerId);
          await this.callbacks.checkProviderReady(message.providerId);
          await this.callbacks.refreshProviderModels(message.providerId);
          await this.postState();
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
          let refreshedModels = false;
          try {
            await this.callbacks.refreshProviderModels(message.providerId);
            refreshedModels = true;
          } catch {
            refreshedModels = false;
          }
          if (readiness.ready || refreshedModels) {
            await this.postState();
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
}
