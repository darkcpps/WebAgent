import { spawn } from 'child_process';
import * as vscode from 'vscode';

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export class TerminalRunner {
  async run(command: string, onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void): Promise<CommandResult> {
    const root = this.getWorkspaceRoot();
    return new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(command, {
        cwd: root,
        shell: true,
        env: process.env,
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk: Buffer) => {
        const value = chunk.toString();
        stdout += value;
        onOutput?.(value, 'stdout');
      });

      child.stderr.on('data', (chunk: Buffer) => {
        const value = chunk.toString();
        stderr += value;
        onOutput?.(value, 'stderr');
      });

      child.on('error', (error) => reject(error));
      child.on('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
    });
  }

  private getWorkspaceRoot(): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      throw new Error('No workspace folder is open.');
    }
    return folder.uri.fsPath;
  }
}
