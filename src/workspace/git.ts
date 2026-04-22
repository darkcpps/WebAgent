import { execFile } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';

const execFileAsync = promisify(execFile);

export class GitService {
  async getStatus(): Promise<string> {
    const root = this.getWorkspaceRoot();
    const { stdout } = await execFileAsync('git', ['-C', root, 'status', '--short']);
    return stdout.trim() || 'Clean working tree';
  }

  async getDiff(): Promise<string> {
    const root = this.getWorkspaceRoot();
    const { stdout } = await execFileAsync('git', ['-C', root, 'diff', '--unified=3']);
    return stdout.trim() || 'No diff';
  }

  async getBranch(): Promise<string> {
    const root = this.getWorkspaceRoot();
    const { stdout } = await execFileAsync('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD']);
    return stdout.trim();
  }

  private getWorkspaceRoot(): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      throw new Error('No workspace folder is open.');
    }
    return folder.uri.fsPath;
  }
}
