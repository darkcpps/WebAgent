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
}
