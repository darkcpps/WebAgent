import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as vscode from 'vscode';

const execFileAsync = promisify(execFile);

export interface RipgrepMatch {
  path: string;
  line: number;
  preview: string;
}

export interface RipgrepOptions {
  regex?: boolean;
  caseInsensitive?: boolean;
  includes?: string[];
  excludes?: string[];
  contextLines?: number;
  maxResults?: number;
}

export class RipgrepService {
  private rgPath: string | undefined;
  private resolved = false;

  async search(query: string, workspaceRoot: string, options: RipgrepOptions = {}): Promise<RipgrepMatch[]> {
    const rg = await this.resolveRgPath();
    if (!rg) {
      return [];
    }

    const args = this.buildArgs(query, workspaceRoot, options);

    try {
      const { stdout } = await execFileAsync(rg, args, {
        timeout: 15000,
        maxBuffer: 5 * 1024 * 1024,
        cwd: workspaceRoot,
      });
      return this.parseOutput(stdout, workspaceRoot);
    } catch (error: unknown) {
      const execError = error as { code?: number; stdout?: string };
      if (execError.code === 1) {
        return [];
      }
      if (execError.stdout) {
        return this.parseOutput(execError.stdout, workspaceRoot);
      }
      return [];
    }
  }

  async isAvailable(): Promise<boolean> {
    return (await this.resolveRgPath()) !== undefined;
  }

  private buildArgs(query: string, _workspaceRoot: string, options: RipgrepOptions): string[] {
    const args: string[] = [
      '--json',
      '--no-heading',
      '--color', 'never',
    ];

    if (!options.regex) {
      args.push('--fixed-strings');
    }

    if (options.caseInsensitive) {
      args.push('--ignore-case');
    }

    if (options.contextLines && options.contextLines > 0) {
      args.push('--context', String(Math.min(options.contextLines, 5)));
    }

    const maxResults = options.maxResults ?? 100;
    args.push('--max-count', String(Math.min(maxResults, 500)));

    args.push('--glob', '!node_modules');
    args.push('--glob', '!.git');
    args.push('--glob', '!dist');

    if (options.includes) {
      for (const include of options.includes) {
        args.push('--glob', include);
      }
    }

    if (options.excludes) {
      for (const exclude of options.excludes) {
        args.push('--glob', `!${exclude}`);
      }
    }

    args.push('--', query, '.');
    return args;
  }

  private parseOutput(stdout: string, workspaceRoot: string): RipgrepMatch[] {
    const results: RipgrepMatch[] = [];

    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as { type: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } };
        if (parsed.type === 'match' && parsed.data) {
          const filePath = parsed.data.path?.text;
          const lineNumber = parsed.data.line_number;
          const lineText = parsed.data.lines?.text?.trimEnd();
          if (filePath && lineNumber !== undefined && lineText !== undefined) {
            const relativePath = path.relative(workspaceRoot, path.resolve(workspaceRoot, filePath)).replace(/\\/g, '/');
            results.push({
              path: relativePath,
              line: lineNumber,
              preview: lineText.length > 300 ? `${lineText.slice(0, 300)}...` : lineText,
            });
          }
        }
      } catch {
        // Skip malformed JSON lines
      }
    }

    return results;
  }

  private async resolveRgPath(): Promise<string | undefined> {
    if (this.resolved) {
      return this.rgPath;
    }
    this.resolved = true;

    const candidates = [
      path.join(vscode.env.appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg'),
      path.join(vscode.env.appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg.exe'),
      path.join(vscode.env.appRoot, 'node_modules', 'vscode-ripgrep', 'bin', 'rg'),
      path.join(vscode.env.appRoot, 'node_modules', 'vscode-ripgrep', 'bin', 'rg.exe'),
    ];

    for (const candidate of candidates) {
      try {
        await execFileAsync(candidate, ['--version'], { timeout: 3000 });
        this.rgPath = candidate;
        return this.rgPath;
      } catch {
        // Try next candidate
      }
    }

    try {
      await execFileAsync('rg', ['--version'], { timeout: 3000 });
      this.rgPath = 'rg';
      return this.rgPath;
    } catch {
      // rg not available
    }

    return undefined;
  }
}
