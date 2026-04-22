import * as vscode from 'vscode';
import type { SessionStore } from '../../storage/sessionStore';

export class SessionTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
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
    return this.sessions.getAll().map((session) => {
      const item = new vscode.TreeItem(session.task || 'Untitled task', vscode.TreeItemCollapsibleState.None);
      item.description = session.status;
      item.tooltip = `${session.providerId} • ${session.status}`;
      item.command = {
        command: 'webagentCode.open',
        title: 'Open WebAgent Code',
        arguments: [session.id],
      };
      return item;
    });
  }
}
