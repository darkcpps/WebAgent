import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import * as vscode from 'vscode';
import { createId } from '../shared/utils';

export class DiffPreviewService {
  async showFileReplacement(relativePath: string, currentContent: string, nextContent: string): Promise<void> {
    const tempDir = path.join(os.tmpdir(), 'webagent-code');
    await fs.mkdir(tempDir, { recursive: true });

    const leftPath = path.join(tempDir, `${createId('old')}-${path.basename(relativePath)}`);
    const rightPath = path.join(tempDir, `${createId('new')}-${path.basename(relativePath)}`);

    await Promise.all([
      fs.writeFile(leftPath, currentContent, 'utf8'),
      fs.writeFile(rightPath, nextContent, 'utf8'),
    ]);

    await vscode.commands.executeCommand(
      'vscode.diff',
      vscode.Uri.file(leftPath),
      vscode.Uri.file(rightPath),
      `WebAgent Preview: ${relativePath}`,
    );
  }

  async showSessionChangePreview(sessionTitle: string, actionSummaries: string[], gitDiff: string): Promise<void> {
    const hasDiff = Boolean(gitDiff && gitDiff.trim() && gitDiff.trim() !== 'No diff');
    const lines: string[] = [
      `# WebAgent Change Preview`,
      '',
      `Session: ${sessionTitle || 'Chat session'}`,
      `Generated: ${new Date().toLocaleString()}`,
      '',
      '## Modified Actions',
      ...(actionSummaries.length
        ? actionSummaries.map((entry, index) => `${index + 1}. ${entry}`)
        : ['No modifying actions were recorded for this session.']),
      '',
      '## Git Diff',
    ];

    if (hasDiff) {
      lines.push('```diff', gitDiff, '```');
    } else {
      lines.push('No unstaged git diff is currently available.');
    }

    const document = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content: lines.join('\n'),
    });
    await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.Beside });
  }
}
