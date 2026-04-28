import * as vscode from 'vscode';
import type { McpManager, McpServerStatus, McpToolInfo } from '../../services/mcpManager';

type McpTreeNode =
  | { kind: 'server'; status: McpServerStatus }
  | { kind: 'tool'; tool: McpToolInfo };

export class McpTreeProvider implements vscode.TreeDataProvider<McpTreeNode | vscode.TreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
  private statuses: McpServerStatus[] | undefined;
  private loading = false;

  constructor(private readonly mcp: McpManager) {}

  refresh(): void {
    this.statuses = undefined;
    this.onDidChangeTreeDataEmitter.fire();
  }

  getTreeItem(element: McpTreeNode | vscode.TreeItem): vscode.TreeItem {
    if (element instanceof vscode.TreeItem) {
      return element;
    }

    if (element.kind === 'tool') {
      const item = new vscode.TreeItem(element.tool.name, vscode.TreeItemCollapsibleState.None);
      item.description = element.tool.description ? 'tool' : undefined;
      item.tooltip = [
        `${element.tool.server}.${element.tool.name}`,
        element.tool.description,
        element.tool.inputSchema ? JSON.stringify(element.tool.inputSchema, null, 2) : undefined,
      ].filter(Boolean).join('\n\n');
      item.iconPath = new vscode.ThemeIcon('symbol-method');
      return item;
    }

    const { status } = element;
    const item = new vscode.TreeItem(
      status.name,
      status.ok && status.tools.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    item.description = status.ok ? `${status.tools.length} tool${status.tools.length === 1 ? '' : 's'}` : 'error';
    item.tooltip = [
      status.ok ? 'MCP server is reachable.' : `MCP server failed: ${status.error ?? 'Unknown error.'}`,
      `Command: ${[status.command, ...status.args].join(' ')}`,
      status.cwd ? `CWD: ${status.cwd}` : undefined,
    ].filter(Boolean).join('\n');
    item.iconPath = new vscode.ThemeIcon(status.ok ? 'pass-filled' : 'error');
    item.contextValue = status.ok ? 'mcpServerReady' : 'mcpServerError';
    return item;
  }

  async getChildren(element?: McpTreeNode | vscode.TreeItem): Promise<Array<McpTreeNode | vscode.TreeItem>> {
    if (element && !(element instanceof vscode.TreeItem)) {
      return element.kind === 'server'
        ? element.status.tools.map((tool) => ({ kind: 'tool', tool }))
        : [];
    }

    if (this.loading) {
      return [new vscode.TreeItem('Checking MCP servers...')];
    }

    if (!this.statuses) {
      this.loading = true;
      try {
        this.statuses = await this.mcp.checkServers();
      } finally {
        this.loading = false;
      }
    }

    if (this.statuses.length === 0) {
      const item = new vscode.TreeItem('No MCP servers configured', vscode.TreeItemCollapsibleState.None);
      item.description = 'empty';
      item.tooltip = 'Add MCP servers to Codex config, .vscode/mcp.json, .cursor/mcp.json, Claude Desktop config, or webagentCode.mcp.servers.';
      item.iconPath = new vscode.ThemeIcon('info');
      return [item];
    }

    return this.statuses.map((status) => ({ kind: 'server', status }));
  }
}
