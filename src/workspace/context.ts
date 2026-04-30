import { execFile } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { unique } from '../shared/utils';
import { WorkspaceFilesService } from './files';
import { SymbolService } from './symbols';
import type { CodebaseProfile } from './codebaseTier';

const execFileAsync = promisify(execFile);

export interface RepoContext {
  workspaceRoot: string;
  summary: string;
  relevantFiles: Array<{ path: string; content: string; reason?: string }>;
  openEditors: string[];
}

export interface RepoContextBuildOptions {
  includeFileContents?: boolean;
  includeWorkspaceRoot?: boolean;
}

interface RankedFile {
  path: string;
  score: number;
  reasons: string[];
}

interface TaskSignals {
  terms: string[];
  phrases: string[];
  explicitPaths: string[];
  extensionHints: string[];
  directoryHints: string[];
}

export class WorkspaceContextService {
  constructor(
    private readonly files: WorkspaceFilesService,
    private readonly symbols?: SymbolService,
  ) {}

  async build(task: string, options: RepoContextBuildOptions = {}, profile?: CodebaseProfile): Promise<RepoContext> {
    const includeFileContents = options.includeFileContents ?? true;
    const includeWorkspaceRoot = options.includeWorkspaceRoot ?? true;
    const workspaceRoot = this.getWorkspaceRoot();
    const openEditors = this.files.getOpenEditors();

    const maxFiles = profile?.maxFileScan ?? 200;
    const candidateFiles = await this.files.listFiles(maxFiles, profile);

    const budgetKb = profile?.contextFilesBudgetKb ?? 40;
    const useMediumPlusRanking = profile && (profile.tier === 'medium' || profile.tier === 'large' || profile.tier === 'massive');

    let ranked = this.rankFiles(task, candidateFiles, openEditors);

    if (useMediumPlusRanking) {
      ranked = await this.applyAdvancedRanking(ranked, task, openEditors, candidateFiles);
    }

    const selected = includeFileContents
      ? await this.selectByBudget(ranked, budgetKb * 1024)
      : ranked.slice(0, 8);

    const relevantFiles = await Promise.all(
      selected.map(async (file) => ({
        path: file.path,
        content: includeFileContents ? await this.smartRead(file.path, profile) : '',
        reason: file.reasons.join(', '),
      })),
    );

    const summary = this.buildSummary(task, candidateFiles, openEditors, workspaceRoot, includeWorkspaceRoot, profile);

    return {
      workspaceRoot,
      summary,
      relevantFiles,
      openEditors,
    };
  }

  private rankFiles(task: string, files: string[], openEditors: string[]): RankedFile[] {
    const signals = this.extractTaskSignals(task);

    const scores = files.map((file) => {
      const normalizedPath = file.replace(/\\/g, '/');
      const lowered = normalizedPath.toLowerCase();
      const basename = path.basename(lowered);
      const dirname = path.dirname(lowered).replace(/\\/g, '/');
      let score = 0;
      const reasons: string[] = [];

      if (openEditors.includes(file)) {
        score += 20;
        reasons.push('open editor');
      }

      if (signals.explicitPaths.some((hint) => lowered.endsWith(hint) || lowered.includes(hint))) {
        score += 40;
        reasons.push('explicit path mention');
      }

      for (const phrase of signals.phrases) {
        const normalizedPhrase = phrase.toLowerCase();
        if (lowered.includes(normalizedPhrase)) {
          score += 18;
          reasons.push(`matched phrase "${phrase}"`);
        }
      }

      for (const term of signals.terms) {
        if (lowered.includes(term)) {
          score += 5;
          reasons.push(`path term "${term}"`);
        }
        if (basename.includes(term)) {
          score += 8;
          reasons.push(`filename term "${term}"`);
        }
      }

      for (const directory of signals.directoryHints) {
        if (dirname.includes(directory) || lowered.startsWith(`${directory}/`) || lowered.includes(`/${directory}/`)) {
          score += 10;
          reasons.push(`likely ${directory} area`);
        }
      }

      if (signals.extensionHints.some((extension) => lowered.endsWith(extension))) {
        score += 6;
        reasons.push('matching file type');
      }

      if (/package\.json|tsconfig|src\//i.test(file)) {
        score += 2;
        reasons.push('core project file');
      }

      return { path: file, score, reasons };
    });

    const ranked = scores.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    const seen = new Set<string>();
    return ranked.filter((item) => {
      if (seen.has(item.path)) {
        return false;
      }
      seen.add(item.path);
      if (item.score <= 0) {
        item.reasons.push('fallback workspace sample');
      }
      item.reasons = unique(item.reasons).slice(0, 4);
      return true;
    });
  }

  private async applyAdvancedRanking(
    ranked: RankedFile[],
    task: string,
    openEditors: string[],
    allFiles: string[],
  ): Promise<RankedFile[]> {
    const fileSet = new Set(allFiles.map((f) => f.replace(/\\/g, '/')));
    const rankedMap = new Map<string, RankedFile>();
    for (const file of ranked) {
      rankedMap.set(file.path.replace(/\\/g, '/'), file);
    }

    // Import graph: boost files that are imported by open editors
    await this.boostByImports(openEditors, rankedMap, fileSet);

    // Git recency: boost recently modified files
    await this.boostByGitRecency(rankedMap);

    // Symbol matching: boost files containing task-mentioned symbols
    await this.boostBySymbols(task, rankedMap, fileSet);

    const result = [...rankedMap.values()];
    result.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return result;
  }

  private async boostByImports(
    openEditors: string[],
    rankedMap: Map<string, RankedFile>,
    fileSet: Set<string>,
  ): Promise<void> {
    for (const editor of openEditors.slice(0, 3)) {
      try {
        const content = await this.files.readFile(editor);
        const importPaths = this.extractImportPaths(content, editor);

        for (const imported of importPaths) {
          const normalizedImport = imported.replace(/\\/g, '/');
          if (fileSet.has(normalizedImport)) {
            const existing = rankedMap.get(normalizedImport);
            if (existing) {
              existing.score += 15;
              existing.reasons.push('imported by open editor');
            } else {
              rankedMap.set(normalizedImport, {
                path: normalizedImport,
                score: 15,
                reasons: ['imported by open editor'],
              });
            }
          }
        }
      } catch {
        // Skip unreadable editors
      }
    }
  }

  private extractImportPaths(content: string, editorPath: string): string[] {
    const dir = path.dirname(editorPath);
    const results: string[] = [];

    const importRegex = /(?:import|require)\s*\(?['"]([^'"]+)['"]\)?/g;
    let match: RegExpExecArray | null;

    while ((match = importRegex.exec(content)) !== null) {
      const raw = match[1];
      if (!raw.startsWith('.')) continue;

      const resolved = path.posix.normalize(path.posix.join(dir.replace(/\\/g, '/'), raw));
      const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'];
      for (const ext of extensions) {
        results.push(resolved + ext);
      }
    }

    return results;
  }

  private async boostByGitRecency(rankedMap: Map<string, RankedFile>): Promise<void> {
    try {
      const root = this.getWorkspaceRoot();
      const { stdout } = await execFileAsync('git', [
        '-C', root, 'log', '--diff-filter=M', '-n', '30', '--name-only', '--pretty=format:',
      ], { timeout: 3000 });

      const recentFiles = new Set(
        stdout.trim().split('\n').filter(Boolean).map((f) => f.trim().replace(/\\/g, '/')),
      );

      for (const filePath of recentFiles) {
        const existing = rankedMap.get(filePath);
        if (existing) {
          existing.score += 8;
          existing.reasons.push('recently modified (git)');
        }
      }
    } catch {
      // Git not available or not a git repo
    }
  }

  private async boostBySymbols(
    task: string,
    rankedMap: Map<string, RankedFile>,
    fileSet: Set<string>,
  ): Promise<void> {
    if (!this.symbols) return;

    const signals = this.extractTaskSignals(task);
    const symbolTerms = signals.terms
      .filter((t) => t.length > 2 && /^[A-Za-z]/.test(t))
      .slice(0, 5);

    for (const term of symbolTerms) {
      try {
        const symbolFiles = await this.symbols.findSymbolFiles(term);
        for (const filePath of symbolFiles.slice(0, 5)) {
          const normalized = filePath.replace(/\\/g, '/');
          if (fileSet.has(normalized)) {
            const existing = rankedMap.get(normalized);
            if (existing) {
              existing.score += 12;
              existing.reasons.push(`contains symbol "${term}"`);
            } else {
              rankedMap.set(normalized, {
                path: normalized,
                score: 12,
                reasons: [`contains symbol "${term}"`],
              });
            }
          }
        }
      } catch {
        // Symbol provider not available
      }
    }
  }

  private async selectByBudget(ranked: RankedFile[], budgetBytes: number): Promise<RankedFile[]> {
    const selected: RankedFile[] = [];
    let usedBytes = 0;
    const maxFiles = 20;

    for (const file of ranked) {
      if (selected.length >= maxFiles) break;
      if (usedBytes >= budgetBytes) break;

      try {
        const content = await this.files.readFile(file.path);
        const fileSize = Buffer.byteLength(content, 'utf8');

        if (usedBytes + Math.min(fileSize, 10000) > budgetBytes && selected.length > 0) {
          break;
        }

        selected.push(file);
        usedBytes += Math.min(fileSize, 10000);
      } catch {
        // Skip unreadable files
      }
    }

    if (selected.length === 0 && ranked.length > 0) {
      selected.push(ranked[0]);
    }

    return selected;
  }

  private async smartRead(filePath: string, profile?: CodebaseProfile): Promise<string> {
    try {
      const content = await this.files.readFile(filePath);
      const size = content.length;

      // Small files: send full content
      if (size <= 2000) {
        return content;
      }

      // Medium files: truncate at a reasonable limit
      const truncateLimit = profile?.tier === 'small' ? 5000 : 8000;
      if (size <= truncateLimit) {
        return content;
      }

      // Large files: try to get outline + truncated content
      if (this.symbols && profile && profile.tier !== 'small') {
        const outline = await this.symbols.getFileOutline(filePath);
        if (outline.length > 0) {
          const outlineStr = outline
            .map((entry) => `  ${entry.kind} ${entry.name} (L${entry.startLine}-${entry.endLine})`)
            .join('\n');
          return `[File outline - ${size} chars total]\n${outlineStr}\n\n[First ${truncateLimit} chars]\n${content.slice(0, truncateLimit)}\n...`;
        }
      }

      return `${content.slice(0, truncateLimit)}\n...[truncated, ${size} chars total]`;
    } catch (error) {
      return `Unable to read ${filePath}: ${(error as Error).message}`;
    }
  }

  private extractTaskSignals(task: string): TaskSignals {
    const lowered = task.toLowerCase();
    const phrases = Array.from(task.matchAll(/[`'""]([^`'""]{3,120})[`'""]/g))
      .map((match) => match[1].trim())
      .filter(Boolean);
    const explicitPaths = Array.from(task.matchAll(/\b(?:[\w.-]+[\\/])+[\w.-]+\b/g))
      .map((match) => match[0].replace(/\\/g, '/').toLowerCase());
    const rawTerms = task
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9_.-]+/)
      .map((term) => term.trim())
      .filter(Boolean);
    const stopWords = new Set([
      'a', 'an', 'and', 'are', 'can', 'does', 'for', 'from', 'how', 'into', 'like', 'make', 'need', 'not', 'or', 'our',
      'please', 'rather', 'should', 'that', 'the', 'then', 'this', 'use', 'what', 'when', 'where', 'with', 'you', 'your',
      'edit', 'file', 'files', 'fix', 'modify', 'change', 'update', 'add', 'remove',
    ]);
    const terms = unique(rawTerms.filter((term) => term.length > 1 && !stopWords.has(term))).slice(0, 24);
    const extensionHints = this.detectExtensionHints(lowered, terms);
    const directoryHints = this.detectDirectoryHints(lowered, terms);

    return {
      terms,
      phrases,
      explicitPaths,
      extensionHints,
      directoryHints,
    };
  }

  private detectExtensionHints(task: string, terms: string[]): string[] {
    const hints = new Set<string>();
    const add = (...extensions: string[]): void => extensions.forEach((extension) => hints.add(extension));
    if (/\b(react|tsx|component|webview|ui|css|style|button|panel|screen)\b/.test(task)) {
      add('.tsx', '.ts', '.css');
    }
    if (/\b(api|service|provider|agent|parser|executor|orchestrator|workspace|mcp|terminal|storage)\b/.test(task)) {
      add('.ts');
    }
    if (/\b(config|setting|command|activation|package|script|contributes)\b/.test(task)) {
      add('.json', '.ts');
    }
    for (const term of terms) {
      if (/^\.[a-z0-9]+$/.test(term)) {
        hints.add(term);
      }
    }
    return Array.from(hints);
  }

  private detectDirectoryHints(task: string, terms: string[]): string[] {
    const hints = new Set<string>();
    const add = (...directories: string[]): void => directories.forEach((directory) => hints.add(directory));
    const text = `${task} ${terms.join(' ')}`;

    if (/\b(agent|tool|action|planner|executor|orchestrator|finish|round)\b/.test(text)) add('agent');
    if (/\b(provider|chatgpt|perplexity|kimi|deepseek|zai|playwright|browser|login|model)\b/.test(text)) add('providers');
    if (/\b(webview|react|tsx|panel|chat ui|button|toggle|style|css)\b/.test(text)) add('webview');
    if (/\b(workspace|file search|read_file|list_files|search_files|context|repo context)\b/.test(text)) add('workspace');
    if (/\b(session|history|storage|conversation)\b/.test(text)) add('storage');
    if (/\b(approval|permission|safety|policy|reject|approve)\b/.test(text)) add('safety');
    if (/\b(mcp|tool server|server tool)\b/.test(text)) add('services', 'ui');
    if (/\b(terminal|command|shell|run_command)\b/.test(text)) add('terminal');

    return Array.from(hints);
  }

  private buildSummary(
    task: string,
    files: string[],
    openEditors: string[],
    workspaceRoot: string,
    includeWorkspaceRoot: boolean,
    profile?: CodebaseProfile,
  ): string {
    const frameworkHints = [
      files.includes('package.json') ? 'Node/JavaScript project' : undefined,
      files.some((file) => file.endsWith('.tsx')) ? 'React or TSX present' : undefined,
      files.some((file) => file.endsWith('.py')) ? 'Python files present' : undefined,
      files.includes('Cargo.toml') ? 'Rust project' : undefined,
      files.includes('go.mod') ? 'Go module present' : undefined,
    ].filter(Boolean);

    return [
      `Task: ${task}`,
      includeWorkspaceRoot ? `Workspace root: ${workspaceRoot}` : undefined,
      `File count scanned: ${files.length}${profile ? ` (tier: ${profile.tier}, total: ${profile.fileCount})` : ''}`,
      `Open editors: ${openEditors.join(', ') || 'None'}`,
      `Detected hints: ${frameworkHints.join(', ') || 'No strong hints'}`,
    ].filter(Boolean).join('\n');
  }

  private getWorkspaceRoot(): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      throw new Error('No workspace folder is open.');
    }
    return folder.uri.fsPath;
  }
}
