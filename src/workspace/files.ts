import * as path from 'path';
import * as vscode from 'vscode';
import { truncate } from '../shared/utils';

export interface SearchResult {
  path: string;
  matches: Array<{ line: number; preview: string }>;
}

export class WorkspaceFilesService {
  constructor(private readonly configuration: vscode.WorkspaceConfiguration) {}

  async listFiles(limit?: number): Promise<string[]> {
    const maxFiles = limit ?? this.configuration.get<number>('maxFiles', 150);
    const includeHidden = this.configuration.get<boolean>('includeHiddenFiles', false);
    const exclude = includeHidden ? '{**/node_modules/**,**/.git/**,**/dist/**}' : '{**/node_modules/**,**/.git/**,**/dist/**,**/.*/**}';
    const files = await vscode.workspace.findFiles('**/*', exclude, maxFiles);
    return files.map((file) => this.toRelativePath(file));
  }

  async readFile(relativePath: string): Promise<string> {
    const uri = this.fromRelativePath(relativePath);
    const data = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(data).toString('utf8');
  }

  async writeFile(relativePath: string, content: string): Promise<void> {
    const uri = this.fromRelativePath(relativePath);
    const folder = path.dirname(uri.fsPath);
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(folder));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
  }

  async deleteFile(relativePath: string): Promise<void> {
    const uri = this.fromRelativePath(relativePath);
    await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: true });
  }

  async renameFile(fromRelativePath: string, toRelativePath: string): Promise<void> {
    const fromUri = this.fromRelativePath(fromRelativePath);
    const toUri = this.fromRelativePath(toRelativePath);
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(toUri.fsPath)));
    await vscode.workspace.fs.rename(fromUri, toUri, { overwrite: false });
  }

  async searchFiles(query: string, limit = 20): Promise<SearchResult[]> {
    const files = await this.listFiles(this.configuration.get<number>('maxFiles', 150));
    const lowered = query.toLowerCase();
    const results: SearchResult[] = [];

    for (const relativePath of files) {
      try {
        const content = await this.readFile(relativePath);
        const lines = content.split(/\r?\n/);
        const matches = lines
          .map((line, index) => ({ line, index }))
          .filter(({ line }) => line.toLowerCase().includes(lowered))
          .slice(0, 5)
          .map(({ line, index }) => ({ line: index + 1, preview: truncate(line, 200) }));

        if (matches.length > 0) {
          results.push({ path: relativePath, matches });
        }

        if (results.length >= limit) {
          break;
        }
      } catch {
        // Skip unreadable/binary files.
      }
    }

    return results;
  }

  getOpenEditors(): string[] {
    return vscode.window.visibleTextEditors
      .map((editor) => this.toRelativePath(editor.document.uri))
      .filter((value, index, array) => array.indexOf(value) === index);
  }

  private getWorkspaceRoot(): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      throw new Error('No workspace folder is open.');
    }
    return folder.uri.fsPath;
  }

  private fromRelativePath(relativePath: string): vscode.Uri {
    return vscode.Uri.file(path.join(this.getWorkspaceRoot(), relativePath));
  }

  private toRelativePath(uri: vscode.Uri): string {
    return path.relative(this.getWorkspaceRoot(), uri.fsPath).replace(/\\/g, '/');
  }
}
