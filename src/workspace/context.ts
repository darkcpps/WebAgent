import * as path from 'path';
import * as vscode from 'vscode';
import { unique } from '../shared/utils';
import { WorkspaceFilesService } from './files';

export interface RepoContext {
  workspaceRoot: string;
  summary: string;
  relevantFiles: Array<{ path: string; content: string }>;
  openEditors: string[];
}

export class WorkspaceContextService {
  constructor(
    private readonly files: WorkspaceFilesService,
  ) {}

  async build(task: string): Promise<RepoContext> {
    const workspaceRoot = this.getWorkspaceRoot();
    const openEditors = this.files.getOpenEditors();
    const candidateFiles = await this.files.listFiles(200);
    const ranked = this.rankFiles(task, candidateFiles, openEditors).slice(0, 8);
    const relevantFiles = await Promise.all(
      ranked.map(async (file) => ({
        path: file,
        content: await this.safeRead(file),
      })),
    );

    const summary = this.buildSummary(task, candidateFiles, openEditors, workspaceRoot);

    return {
      workspaceRoot,
      summary,
      relevantFiles,
      openEditors,
    };
  }

  private rankFiles(task: string, files: string[], openEditors: string[]): string[] {
    const terms = task
      .toLowerCase()
      .split(/[^a-z0-9_\-.]+/)
      .filter(Boolean);

    const scores = files.map((file) => {
      const lowered = file.toLowerCase();
      let score = 0;
      if (openEditors.includes(file)) {
        score += 20;
      }
      for (const term of terms) {
        if (lowered.includes(term)) {
          score += 5;
        }
        if (path.basename(lowered).includes(term)) {
          score += 8;
        }
      }
      if (/package\.json|tsconfig|src\//i.test(file)) {
        score += 2;
      }
      return { file, score };
    });

    return unique(scores.sort((a, b) => b.score - a.score).map((item) => item.file));
  }

  private buildSummary(task: string, files: string[], openEditors: string[], workspaceRoot: string): string {
    const frameworkHints = [
      files.includes('package.json') ? 'Node/JavaScript project' : undefined,
      files.some((file) => file.endsWith('.tsx')) ? 'React or TSX present' : undefined,
      files.some((file) => file.endsWith('.py')) ? 'Python files present' : undefined,
      files.includes('Cargo.toml') ? 'Rust project' : undefined,
      files.includes('go.mod') ? 'Go module present' : undefined,
    ].filter(Boolean);

    return [
      `Task: ${task}`,
      `Workspace root: ${workspaceRoot}`,
      `File count scanned: ${files.length}`,
      `Open editors: ${openEditors.join(', ') || 'None'}`,
      `Detected hints: ${frameworkHints.join(', ') || 'No strong hints'}`,
    ].join('\n');
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
