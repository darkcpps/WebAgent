import * as vscode from 'vscode';
import type { BridgeCompanionManager } from '../../services/bridgeCompanionManager';
import type { ProviderRegistry } from '../../providers/registry';
import type { SessionStore } from '../../storage/sessionStore';
import type { BridgeUiState } from '../../shared/types';

export class BridgeTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private lastState?: BridgeUiState;

  constructor(
    private readonly bridgeCompanion: BridgeCompanionManager,
    private readonly providers: ProviderRegistry,
    private readonly sessions: SessionStore,
    private readonly getBridgeState: () => Promise<BridgeUiState>,
  ) {
    // Refresh periodically
    setInterval(() => this.refresh(), 3000);
  }

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element) {
      return [];
    }

    const state = await this.getBridgeState();
    this.lastState = state;

    const items: vscode.TreeItem[] = [];

    // Transport
    const transportItem = new vscode.TreeItem('Configured Transport');
    transportItem.description = state.transport;
    transportItem.iconPath = new vscode.ThemeIcon('circuit-board');
    items.push(transportItem);

    const runtimeItem = new vscode.TreeItem('Active Runtime');
    runtimeItem.description = state.activeRuntime === 'playwright' ? 'managed' : 'bridge';
    runtimeItem.iconPath = new vscode.ThemeIcon('debug-alt');
    items.push(runtimeItem);

    const modeItem = new vscode.TreeItem('Managed Mode');
    modeItem.description = state.managedMode;
    modeItem.iconPath = new vscode.ThemeIcon('window');
    items.push(modeItem);

    // Companion Status
    const companionItem = new vscode.TreeItem('Companion');
    companionItem.description = state.companionReachable ? 'Reachable' : 'Offline';
    companionItem.iconPath = new vscode.ThemeIcon('server', state.companionReachable ? new vscode.ThemeColor('debugIcon.startForeground') : undefined);
    companionItem.contextValue = state.companionReachable ? 'companion-online' : 'companion-offline';
    items.push(companionItem);

    // Browser Link
    const browserItem = new vscode.TreeItem('Browser Link');
    browserItem.description = state.browserConnected ? 'Connected' : 'Disconnected';
    browserItem.iconPath = new vscode.ThemeIcon('globe', state.browserConnected ? new vscode.ThemeColor('debugIcon.startForeground') : undefined);
    items.push(browserItem);

    // Readiness
    const readyItem = new vscode.TreeItem('z.ai Status');
    readyItem.description = state.ready ? 'Ready' : state.loginRequired ? 'Login Required' : 'Not Ready';
    readyItem.iconPath = new vscode.ThemeIcon('check-all', state.ready ? new vscode.ThemeColor('debugIcon.startForeground') : undefined);
    items.push(readyItem);

    // Owned Process
    const ownedItem = new vscode.TreeItem('Owned Process');
    ownedItem.description = state.companionOwnedByExtension ? 'Yes' : 'No';
    ownedItem.iconPath = new vscode.ThemeIcon('shield');
    items.push(ownedItem);

    if (state.lastError) {
      const errorItem = new vscode.TreeItem('Last Error');
      errorItem.description = state.lastError;
      errorItem.tooltip = state.lastError;
      errorItem.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
      items.push(errorItem);
    }

    return items;
  }
}
