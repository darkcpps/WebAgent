import * as vscode from 'vscode';
import type { SessionStore } from '../../storage/sessionStore';

export class ActivityTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  constructor(private readonly sessions: SessionStore) {
    sessions.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<vscode.TreeItem[]> {
    const active = this.sessions.getActive();
    if (!active) {
      return [new vscode.TreeItem('No active session')];
    }

    const items = active.actionHistory.slice(-25).reverse().map((action) => {
      const item = new vscode.TreeItem(action.summary || action.type, vscode.TreeItemCollapsibleState.None);
      item.description = action.status === 'running' ? 'running...' : action.status;
      item.tooltip = action.preview ?? action.summary;
      if (action.status === 'pending' && action.requiresApproval) {
        item.contextValue = 'pendingAction';
      }
      return item;
    });

    if (items.length === 0) {
      return [new vscode.TreeItem('No actions yet')];
    }

    return items;
  }
}
