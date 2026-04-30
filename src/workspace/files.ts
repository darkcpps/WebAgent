import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { truncate } from '../shared/utils';
import { RipgrepService, type RipgrepMatch } from './ripgrep';
import type { CodebaseProfile } from './codebaseTier';

const execFileAsync = promisify(execFile);

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

export interface DirectoryEntry {
  name: string;
  type: 'file' | 'directory';
  size?: number;
  childCount?: number;
}

export class WorkspaceFilesService {
  private static readonly READ_FILE_DEFAULT_LIMIT_LINES = 250;
  private static readonly READ_FILE_MAX_CHARS = 30000;

  private readonly ripgrep = new RipgrepService();
  private gitignorePatterns: string[] | undefined;

  constructor(private readonly configuration: vscode.WorkspaceConfiguration) {}

  async listFiles(limit?: number, profile?: CodebaseProfile): Promise<string[]> {
    const effectiveLimit = limit ?? profile?.maxFileScan ?? this.configuration.get<number>('maxFiles', 500);

    if (profile?.isGitRepo) {
      const gitFiles = await this.tryGitLsFiles(effectiveLimit);
      if (gitFiles !== undefined) {
        return gitFiles;
      }
    }

    const files = await vscode.workspace.findFiles('**/*', await this.getExcludeGlob(), effectiveLimit);
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

    const useRipgrep = this.configuration.get<boolean>('useRipgrep', true);
    if (useRipgrep) {
      const rgResults = await this.tryRipgrepSearch(normalizedQuery, { maxResults: limit });
      if (rgResults !== undefined) {
        return rgResults;
      }
    }

    return this.naiveSearchFiles(normalizedQuery, limit);
  }

  async grepSearch(
    pattern: string,
    options: { regex?: boolean; includes?: string[]; excludes?: string[]; limit?: number; contextLines?: number } = {},
  ): Promise<SearchResult[]> {
    const normalizedPattern = pattern.trim();
    if (!normalizedPattern) {
      return [];
    }

    const root = this.getWorkspaceRoot();
    const matches = await this.ripgrep.search(normalizedPattern, root, {
      regex: options.regex,
      includes: options.includes,
      excludes: options.excludes,
      maxResults: options.limit ?? 30,
      contextLines: options.contextLines,
    });

    if (matches.length === 0) {
      if (!options.regex) {
        return this.naiveSearchFiles(normalizedPattern, options.limit ?? 30);
      }
      return [];
    }

    return this.groupRipgrepMatches(matches, options.limit ?? 30);
  }

  async searchCode(query: string, limit = 20): Promise<SearchResult[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return [];
    }

    const literalResults = await this.searchFiles(normalizedQuery, limit);
    const maxFiles = this.configuration.get<number>('maxFiles', 500);
    const files = await this.listFiles(maxFiles);
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
    const maxFiles = Math.max(limit, this.configuration.get<number>('maxFiles', 500));
    const files = await this.listFiles(maxFiles);
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

  async listDirectory(relativePath: string, depth = 2): Promise<DirectoryEntry[]> {
    const root = this.getWorkspaceRoot();
    const targetDir = relativePath ? path.resolve(root, relativePath) : root;
    const resolved = path.relative(root, targetDir);

    if (resolved.startsWith('..') || path.isAbsolute(resolved)) {
      throw new Error(`Path is outside the workspace: ${relativePath}`);
    }

    return this.walkDirectory(targetDir, root, Math.min(depth, 5), 0);
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

  private async tryGitLsFiles(limit: number): Promise<string[] | undefined> {
    try {
      const root = this.getWorkspaceRoot();
      const { stdout } = await execFileAsync('git', ['-C', root, 'ls-files'], {
        timeout: 5000,
        maxBuffer: 10 * 1024 * 1024,
      });

      const excludeGlob = await this.getExcludeGlob();
      const excludePatterns = this.parseExcludeGlob(excludeGlob);

      return stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .filter((file) => !excludePatterns.some((pattern) => this.matchesExcludePattern(file, pattern)))
        .slice(0, limit)
        .map((file) => file.replace(/\\/g, '/'));
    } catch {
      return undefined;
    }
  }

  private parseExcludeGlob(glob: string): string[] {
    const inner = glob.replace(/^\{/, '').replace(/\}$/, '');
    return inner.split(',').map((pattern) => pattern.replace(/\*\*/g, '').replace(/\//g, '').trim()).filter(Boolean);
  }

  private matchesExcludePattern(filePath: string, pattern: string): boolean {
    const parts = filePath.replace(/\\/g, '/').split('/');
    return parts.some((part) => {
      if (pattern.startsWith('.')) {
        return part === pattern || part.startsWith('.');
      }
      return part === pattern;
    });
  }

  private async tryRipgrepSearch(query: string, options: { maxResults?: number }): Promise<SearchResult[] | undefined> {
    const root = this.getWorkspaceRoot();
    const matches = await this.ripgrep.search(query, root, {
      maxResults: options.maxResults ?? 20,
    });

    if (matches.length === 0 && !(await this.ripgrep.isAvailable())) {
      return undefined;
    }

    return this.groupRipgrepMatches(matches, options.maxResults ?? 20);
  }

  private groupRipgrepMatches(matches: RipgrepMatch[], limit: number): SearchResult[] {
    const byPath = new Map<string, SearchResult>();
    for (const match of matches) {
      const existing = byPath.get(match.path);
      if (existing) {
        if (existing.matches.length < 5) {
          existing.matches.push({ line: match.line, preview: truncate(match.preview, 200) });
        }
      } else {
        byPath.set(match.path, {
          path: match.path,
          matches: [{ line: match.line, preview: truncate(match.preview, 200) }],
        });
      }
    }
    return [...byPath.values()].slice(0, limit);
  }

  private async naiveSearchFiles(query: string, limit: number): Promise<SearchResult[]> {
    const maxFiles = this.configuration.get<number>('maxFiles', 500);
    const scanLimit = Math.max(10, this.configuration.get<number>('searchScanLimit', 200));
    const openEditors = this.getOpenEditors();
    const files = (await this.listFiles(maxFiles))
      .sort((left, right) => this.scoreSearchPath(right, query, openEditors) - this.scoreSearchPath(left, query, openEditors))
      .slice(0, scanLimit);
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

  private async walkDirectory(dir: string, root: string, maxDepth: number, currentDepth: number): Promise<DirectoryEntry[]> {
    if (currentDepth >= maxDepth) {
      return [];
    }

    const entries: DirectoryEntry[] = [];
    try {
      const items = await fs.promises.readdir(dir, { withFileTypes: true });
      const skipNames = new Set(['node_modules', '.git', 'dist', '.next', '__pycache__', '.venv']);

      for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
        if (skipNames.has(item.name)) continue;
        if (item.name.startsWith('.') && !this.configuration.get<boolean>('includeHiddenFiles', false)) continue;

        if (item.isDirectory()) {
          const childPath = path.join(dir, item.name);
          let childCount = 0;
          try {
            const children = await fs.promises.readdir(childPath);
            childCount = children.length;
          } catch {
            // Permission denied or other error
          }

          entries.push({
            name: item.name,
            type: 'directory',
            childCount,
          });
        } else if (item.isFile()) {
          let size: number | undefined;
          try {
            const stat = await fs.promises.stat(path.join(dir, item.name));
            size = stat.size;
          } catch {
            // Stat error
          }

          entries.push({
            name: item.name,
            type: 'file',
            size,
          });
        }
      }
    } catch {
      // Directory read error
    }

    return entries;
  }

  private getWorkspaceRoot(): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      throw new Error('No workspace folder is open.');
    }
    return folder.uri.fsPath;
  }

  private async getExcludeGlob(): Promise<string> {
    const includeHidden = this.configuration.get<boolean>('includeHiddenFiles', false);
    const customExcludes = this.configuration.get<string[]>('excludePatterns', []);

    const baseExcludes = includeHidden
      ? ['**/node_modules/**', '**/.git/**', '**/dist/**']
      : ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/.*/**'];

    const gitignoreExcludes = await this.loadGitignorePatterns();
    const allExcludes = [...baseExcludes, ...gitignoreExcludes, ...customExcludes.map((p) => `**/${p}/**`)];

    return `{${allExcludes.join(',')}}`;
  }

  private async loadGitignorePatterns(): Promise<string[]> {
    if (this.gitignorePatterns !== undefined) {
      return this.gitignorePatterns;
    }

    this.gitignorePatterns = [];
    try {
      const root = this.getWorkspaceRoot();
      const gitignorePath = path.join(root, '.gitignore');
      const content = await fs.promises.readFile(gitignorePath, 'utf8');
      const patterns = content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
        .filter((line) => !line.startsWith('!'))
        .map((line) => {
          const cleaned = line.replace(/^\//, '').replace(/\/$/, '');
          if (cleaned.includes('/') || cleaned.includes('*')) {
            return `**/${cleaned}`;
          }
          return `**/${cleaned}/**`;
        });
      this.gitignorePatterns = patterns.slice(0, 30);
    } catch {
      // No .gitignore or unreadable
    }

    return this.gitignorePatterns;
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

  fromRelativePath(relativePath: string): vscode.Uri {
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
