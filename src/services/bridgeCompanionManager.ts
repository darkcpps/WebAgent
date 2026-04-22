import * as net from 'net';
import * as path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as vscode from 'vscode';

const COMPANION_HOST = '127.0.0.1';
const COMPANION_PORT = 17833;

type StartReason = 'activate' | 'provider-request' | 'manual';

export class BridgeCompanionManager implements vscode.Disposable {
  private process?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private readonly output = vscode.window.createOutputChannel('WebAgent Bridge');
  private disposed = false;
  private startupNotified = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

  async ensureRunning(reason: StartReason): Promise<void> {
    if (this.disposed) {
      return;
    }

    if (reason !== 'manual' && !this.shouldUseBridgeTransport()) {
      return;
    }

    if (reason !== 'manual' && !this.isAutoStartEnabled()) {
      return;
    }

    if (await this.isCompanionReachable()) {
      return;
    }

    if (this.starting) {
      await this.starting;
      return;
    }

    this.starting = this.startProcess(reason);
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  async stopOwnedProcess(): Promise<void> {
    const current = this.process;
    this.process = undefined;
    if (!current || current.killed) {
      return;
    }

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        current.kill('SIGKILL');
        resolve();
      }, 1500);

      current.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      current.kill('SIGTERM');
    });
  }

  async restartOwnedProcess(): Promise<void> {
    await this.stopOwnedProcess();
    await this.ensureRunning('manual');
  }

  isOwnedRunning(): boolean {
    return Boolean(this.process && !this.process.killed);
  }

  async isReachable(): Promise<boolean> {
    return this.isCompanionReachable();
  }

  showLogs(preserveFocus = false): void {
    this.output.show(preserveFocus);
  }

  dispose(): void {
    this.disposed = true;
    void this.stopOwnedProcess();
    this.output.dispose();
  }

  private shouldUseBridgeTransport(): boolean {
    const transport = vscode.workspace.getConfiguration('webagentCode').get<string>('transport.zai', 'bridge');
    return transport === 'bridge';
  }

  private isAutoStartEnabled(): boolean {
    return vscode.workspace.getConfiguration('webagentCode').get<boolean>('bridge.autoStartCompanion', true);
  }

  private companionScriptPath(): string {
    return path.join(this.context.extensionUri.fsPath, 'resources', 'zai-bridge-companion', 'server.js');
  }

  private async startProcess(reason: StartReason): Promise<void> {
    const scriptPath = this.companionScriptPath();
    const launch = this.resolveNodeLaunch(scriptPath);
    const child = spawn(launch.command, launch.args, {
      cwd: this.context.extensionUri.fsPath,
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.process = child;
    this.output.appendLine(`[bridge] Starting companion (${reason}) with ${launch.command} ${launch.args.join(' ')}`);

    child.stdout.on('data', (chunk: Buffer) => {
      this.output.append(chunk.toString('utf8'));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      this.output.append(chunk.toString('utf8'));
    });

    child.on('exit', (code, signal) => {
      if (this.process === child) {
        this.process = undefined;
      }
      this.output.appendLine(`[bridge] Companion exited (code=${code ?? 'null'}, signal=${signal ?? 'null'}).`);
    });
    child.on('error', (error) => {
      if (this.process === child) {
        this.process = undefined;
      }
      this.output.appendLine(`[bridge] Failed to start companion process: ${error.message}`);
    });

    const ready = await this.waitForReachable(10000);
    if (!ready) {
      const logsAction = 'Open Bridge Logs';
      const picked = await vscode.window.showWarningMessage(
        'WebAgent bridge companion did not start in time. Bridge mode may fail until companion is running.',
        logsAction,
      );
      if (picked === logsAction) {
        this.output.show(true);
      }
      return;
    }

    if (!this.startupNotified) {
      this.startupNotified = true;
      this.output.appendLine('[bridge] Companion reachable on ws://127.0.0.1:17833/ws');
    }
  }

  private resolveNodeLaunch(scriptPath: string): { command: string; args: string[] } {
    // If process.execPath is Node.js, use it directly.
    if (/\bnode(\.exe)?$/i.test(path.basename(process.execPath))) {
      return {
        command: process.execPath,
        args: [scriptPath],
      };
    }

    // Fallback to 'node' in PATH, which is safer than complex cmd.exe quoting.
    return {
      command: 'node',
      args: [scriptPath],
    };
  }

  private async waitForReachable(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.isCompanionReachable()) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  }

  private async isCompanionReachable(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const socket = new net.Socket();
      let settled = false;

      const finish = (value: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        socket.destroy();
        resolve(value);
      };

      socket.setTimeout(600);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
      socket.connect(COMPANION_PORT, COMPANION_HOST);
    });
  }
}
