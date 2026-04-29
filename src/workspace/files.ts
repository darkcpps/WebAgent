import * as path from 'path';
import * as vscode from 'vscode';
import { truncate } from '../shared/utils';

export interface SearchResult {
  path: string;
  matches: Array<{ line: number; preview: string }>;
}

export interface FileReadRequest {
  path: string;
  startLine?: number;
  limit?: number;
}

export interface FileReadWindow {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  totalChars: number;
  content: string;
  truncated: boolean;
}

export interface RepoInspection {
  fileCount: number;
  openEditors: string[];
  keyFiles: string[];
  matchingFiles: string[];
  packageScripts: string[];
}

export class WorkspaceFilesService {
  private static readonly READ_FILE_DEFAULT_LIMIT_LINES = 250;
  private static readonly READ_FILE_MAX_CHARS = 30000;

  constructor(private readonly configuration: vscode.WorkspaceConfiguration) {}

  async listFiles(limit?: number): Promise<string[]> {
    const maxFiles = limit ?? this.configuration.get<number>('maxFiles', 150);
    const files = await vscode.workspace.findFiles('**/*', this.getExcludeGlob(), maxFiles);
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
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return [];
    }

    const maxFiles = this.configuration.get<number>('maxFiles', 150);
    const scanLimit = Math.max(10, this.configuration.get<number>('searchScanLimit', 80));
    const openEditors = this.getOpenEditors();
    const files = (await this.listFiles(maxFiles))
      .sort((left, right) => this.scoreSearchPath(right, normalizedQuery, openEditors) - this.scoreSearchPath(left, normalizedQuery, openEditors))
      .slice(0, scanLimit);
    const lowered = normalizedQuery.toLowerCase();
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

  async searchCode(query: string, limit = 20): Promise<SearchResult[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return [];
    }

    const literalResults = await this.searchFiles(normalizedQuery, limit);
    const files = await this.listFiles(this.configuration.get<number>('maxFiles', 150));
    const lowered = normalizedQuery.toLowerCase();
    const filenameMatches = files
      .filter((file) => file.toLowerCase().includes(lowered))
      .slice(0, limit)
      .map((file) => ({ path: file, matches: [{ line: 1, preview: 'Filename match' }] }));

    const byPath = new Map<string, SearchResult>();
    for (const result of [...literalResults, ...filenameMatches]) {
      if (!byPath.has(result.path)) {
        byPath.set(result.path, result);
      }
    }

    return [...byPath.values()].slice(0, limit);
  }

  async readFileWindow(request: FileReadRequest): Promise<FileReadWindow> {
    const content = await this.readFile(request.path);
    const lines = content.split(/\r?\n/);
    const totalLines = lines.length;
    const requestedStartLine = request.startLine ?? 1;
    const startLine = Math.min(Math.max(requestedStartLine, 1), Math.max(totalLines, 1));
    const limit = request.limit ?? WorkspaceFilesService.READ_FILE_DEFAULT_LIMIT_LINES;
    const endLine = Math.min(startLine + limit - 1, totalLines);
    const selectedLines = lines.slice(startLine - 1, endLine);
    let body = selectedLines.map((line, index) => `${startLine + index}: ${line}`).join('\n');
    let truncated = false;

    if (body.length > WorkspaceFilesService.READ_FILE_MAX_CHARS) {
      body = body.slice(0, WorkspaceFilesService.READ_FILE_MAX_CHARS);
      truncated = true;
    }

    return {
      path: request.path,
      startLine,
      endLine,
      totalLines,
      totalChars: content.length,
      content: body,
      truncated,
    };
  }

  async inspectRepo(query?: string, limit = 80): Promise<RepoInspection> {
    const files = await this.listFiles(Math.max(limit, this.configuration.get<number>('maxFiles', 150)));
    const openEditors = this.getOpenEditors();
    const keyPatterns = [
      /^package\.json$/,
      /^tsconfig\.json$/,
      /^README/i,
      /^src\/extension/i,
      /^src\/agent\//,
      /^src\/providers\//,
      /^src\/workspace\//,
    ];
    const keyFiles = files.filter((file) => keyPatterns.some((pattern) => pattern.test(file))).slice(0, 40);
    const loweredQuery = query?.trim().toLowerCase();
    const matchingFiles = loweredQuery
      ? files.filter((file) => file.toLowerCase().includes(loweredQuery)).slice(0, 40)
      : [];
    const packageScripts = await this.readPackageScripts().catch(() => []);

    return {
      fileCount: files.length,
      openEditors,
      keyFiles,
      matchingFiles,
      packageScripts,
    };
  }

  async readPackageScripts(): Promise<string[]> {
    const packageJson = JSON.parse(await this.readFile('package.json')) as { scripts?: Record<string, unknown> };
    return Object.keys(packageJson.scripts ?? {}).sort();
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

  private getExcludeGlob(): string {
    const includeHidden = this.configuration.get<boolean>('includeHiddenFiles', false);
    return includeHidden
      ? '{**/node_modules/**,**/.git/**,**/dist/**}'
      : '{**/node_modules/**,**/.git/**,**/dist/**,**/.*/**}';
  }

  private scoreSearchPath(relativePath: string, query: string, openEditors: string[]): number {
    const loweredPath = relativePath.toLowerCase();
    const loweredName = path.basename(loweredPath);
    const terms = query
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9_.-]+/)
      .filter((term) => term.length > 1);
    let score = 0;

    for (const term of terms) {
      if (loweredName.includes(term)) {
        score += 8;
      }
      if (loweredPath.includes(term)) {
        score += 4;
      }
    }

    if (openEditors.includes(relativePath)) {
      score += 20;
    }

    return score;
  }

  private fromRelativePath(relativePath: string): vscode.Uri {
    const root = this.getWorkspaceRoot();
    const resolved = path.resolve(root, relativePath);
    const relative = path.relative(root, resolved);

    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Path is outside the workspace: ${relativePath}`);
    }

    return vscode.Uri.file(resolved);
  }

  private toRelativePath(uri: vscode.Uri): string {
    return path.relative(this.getWorkspaceRoot(), uri.fsPath).replace(/\\/g, '/');
  }
}
