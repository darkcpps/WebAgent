import * as path from 'path';
import * as vscode from 'vscode';
import { unique } from '../shared/utils';
import { WorkspaceFilesService } from './files';

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
  ) {}

  async build(task: string, options: RepoContextBuildOptions = {}): Promise<RepoContext> {
    const includeFileContents = options.includeFileContents ?? true;
    const includeWorkspaceRoot = options.includeWorkspaceRoot ?? true;
    const workspaceRoot = this.getWorkspaceRoot();
    const openEditors = this.files.getOpenEditors();
    const candidateFiles = await this.files.listFiles(200);
    const ranked = this.rankFiles(task, candidateFiles, openEditors).slice(0, 8);
    const relevantFiles = await Promise.all(
      ranked.map(async (file) => ({
        path: file.path,
        content: includeFileContents ? await this.safeRead(file.path) : '',
        reason: file.reasons.join(', '),
      })),
    );

    const summary = this.buildSummary(task, candidateFiles, openEditors, workspaceRoot, includeWorkspaceRoot);

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

  private extractTaskSignals(task: string): TaskSignals {
    const lowered = task.toLowerCase();
    const phrases = Array.from(task.matchAll(/[`'"]([^`'"]{3,120})[`'"]/g))
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
      `File count scanned: ${files.length}`,
      `Open editors: ${openEditors.join(', ') || 'None'}`,
      `Detected hints: ${frameworkHints.join(', ') || 'No strong hints'}`,
    ].filter(Boolean).join('\n');
  }

  private async safeRead(file: string): Promise<string> {
    try {
      const content = await this.files.readFile(file);
      return content.length > 5000 ? `${content.slice(0, 5000)}\n...` : content;
    } catch (error) {
      return `Unable to read ${file}: ${(error as Error).message}`;
    }
  }

  private getWorkspaceRoot(): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      throw new Error('No workspace folder is open.');
    }
    return folder.uri.fsPath;
  }
}
