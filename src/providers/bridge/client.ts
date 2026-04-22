import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import WebSocket from 'ws';
import type { ProviderEvent } from '../base';
import {
  type BridgeEventMessage,
  type BridgeHelloMessage,
  type BridgeMethod,
  type BridgeRequestMessage,
  type BridgeResponseMessage,
  isBridgeEventMessage,
  isBridgeResponseMessage,
} from './protocol';

interface PendingRequest {
  method: BridgeMethod;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
}

type StreamListener = (event: ProviderEvent) => void;

const DEFAULT_ENDPOINT = 'ws://127.0.0.1:17833/ws';

export class ZaiBridgeClient {
  private socket?: WebSocket;
  private connecting?: Promise<void>;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly streamListeners = new Map<string, Set<StreamListener>>();
  private closed = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    context.subscriptions.push({
      dispose: () => {
        void this.dispose();
      },
    });
  }

  async dispose(): Promise<void> {
    this.closed = true;
    const socket = this.socket;
    this.socket = undefined;
    this.connecting = undefined;

    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.close();
    }

    for (const [, request] of this.pending) {
      clearTimeout(request.timeout);
      request.reject(new Error('[bridge] Companion connection closed.'));
    }
    this.pending.clear();
    this.streamListeners.clear();
  }

  async request(method: BridgeMethod, params?: Record<string, unknown>): Promise<unknown> {
    await this.ensureConnected();
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('[bridge] Companion is not connected.');
    }

    const id = randomUUID();
    const timeoutMs = this.requestTimeoutMs();
    const message: BridgeRequestMessage = {
      kind: 'request',
      id,
      method,
      params,
      timestamp: Date.now(),
    };

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`[bridge] ${method} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);

      this.pending.set(id, {
        method,
        resolve,
        reject,
        timeout,
      });

      try {
        socket.send(JSON.stringify(message));
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timeout);
        reject(new Error(`[bridge] Failed to send ${method}: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  }

  subscribeStream(streamId: string, listener: StreamListener): () => void {
    const existing = this.streamListeners.get(streamId) ?? new Set<StreamListener>();
    existing.add(listener);
    this.streamListeners.set(streamId, existing);
    return () => {
      const listeners = this.streamListeners.get(streamId);
      if (!listeners) {
        return;
      }
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.streamListeners.delete(streamId);
      }
    };
  }

  private endpoint(): string {
    return DEFAULT_ENDPOINT;
  }

  private shouldAutoReconnect(): boolean {
    return vscode.workspace.getConfiguration('webagentCode').get<boolean>('bridge.autoReconnect', true);
  }

  private requestTimeoutMs(): number {
    const configured = vscode.workspace.getConfiguration('webagentCode').get<number>('bridge.requestTimeoutMs', 15000);
    if (!configured || Number.isNaN(configured)) {
      return 15000;
    }
    return Math.max(1000, configured);
  }

  private async ensureConnected(): Promise<void> {
    if (this.closed) {
      throw new Error('[bridge] Bridge client is disposed.');
    }

    if (this.socket?.readyState === WebSocket.OPEN) {
      return;
    }

    if (this.connecting) {
      await this.connecting;
      return;
    }

    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.endpoint());
      let settled = false;
      const timeoutMs = Math.max(this.requestTimeoutMs(), 4000);

      const fail = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        this.connecting = undefined;
        reject(error);
      };

      const timeout = setTimeout(() => {
        socket.close();
        fail(new Error(`[bridge] Could not connect to companion at ${this.endpoint()}.`));
      }, timeoutMs);

      socket.on('open', () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        this.socket = socket;
        this.connecting = undefined;
        this.attachSocketHandlers(socket);
        this.sendHello(socket);
        resolve();
      });

      socket.on('error', (error) => {
        fail(new Error(`[bridge] ${error.message}`));
      });
    });

    await this.connecting;
  }

  private sendHello(socket: WebSocket): void {
    const hello: BridgeHelloMessage = {
      kind: 'hello',
      role: 'vscode',
      version: this.context.extension.packageJSON.version ?? '0.0.0',
      timestamp: Date.now(),
    };
    socket.send(JSON.stringify(hello));
  }

  private attachSocketHandlers(socket: WebSocket): void {
    socket.on('message', (raw) => {
      this.handleMessage(raw.toString());
    });

    socket.on('close', () => {
      if (this.socket === socket) {
        this.socket = undefined;
      }
      this.rejectAllPending('[bridge] Companion connection closed.');
      if (this.shouldAutoReconnect() && !this.closed) {
        // Reconnect lazily on next request.
      }
    });

    socket.on('error', () => {
      // Close handler will finalize state.
    });
  }

  private rejectAllPending(reason: string): void {
    for (const [, request] of this.pending) {
      clearTimeout(request.timeout);
      request.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private handleMessage(serialized: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      return;
    }

    if (isBridgeResponseMessage(parsed)) {
      this.handleResponse(parsed);
      return;
    }

    if (isBridgeEventMessage(parsed)) {
      this.handleEvent(parsed);
    }
  }

  private handleResponse(message: BridgeResponseMessage): void {
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timeout);

    if (message.ok) {
      pending.resolve(message.result);
      return;
    }

    const detail = message.error ? `${message.error.code}: ${message.error.message}` : 'Unknown bridge error.';
    pending.reject(new Error(`[bridge] ${pending.method} failed: ${detail}`));
  }

  private handleEvent(message: BridgeEventMessage): void {
    const listeners = this.streamListeners.get(message.streamId);
    if (!listeners?.size) {
      return;
    }

    for (const listener of listeners) {
      try {
        listener(message.event);
      } catch {
        // Keep delivering to other listeners.
      }
    }
  }
}
