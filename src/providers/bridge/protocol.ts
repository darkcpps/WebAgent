import type { ProviderEvent } from '../base';

export type BridgeRole = 'vscode' | 'browser';

export type BridgeMethod =
  | 'health'
  | 'checkReady'
  | 'startNewConversation'
  | 'openConversation'
  | 'getCurrentConversationId'
  | 'listModels'
  | 'selectModel'
  | 'sendPrompt'
  | 'streamStart'
  | 'stop';

export type BridgeErrorCode =
  | 'BROWSER_NOT_CONNECTED'
  | 'TAB_NOT_FOUND'
  | 'TIMEOUT'
  | 'BAD_REQUEST'
  | 'NOT_READY'
  | 'INTERNAL'
  | 'DISCONNECTED';

export interface BridgeHelloMessage {
  kind: 'hello';
  role: BridgeRole;
  version: string;
  timestamp: number;
}

export interface BridgeRequestMessage {
  kind: 'request';
  id: string;
  method: BridgeMethod;
  params?: Record<string, unknown>;
  timestamp: number;
}

export interface BridgeResponseError {
  code: BridgeErrorCode | string;
  message: string;
  retriable?: boolean;
}

export interface BridgeResponseMessage {
  kind: 'response';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: BridgeResponseError;
  timestamp: number;
}

export interface BridgeEventMessage {
  kind: 'event';
  streamId: string;
  event: ProviderEvent;
  timestamp: number;
}

export type BridgeMessage = BridgeHelloMessage | BridgeRequestMessage | BridgeResponseMessage | BridgeEventMessage;

export function isBridgeResponseMessage(value: unknown): value is BridgeResponseMessage {
  return Boolean(
    value &&
      typeof value === 'object' &&
      (value as BridgeResponseMessage).kind === 'response' &&
      typeof (value as BridgeResponseMessage).id === 'string',
  );
}

export function isBridgeEventMessage(value: unknown): value is BridgeEventMessage {
  return Boolean(
    value &&
      typeof value === 'object' &&
      (value as BridgeEventMessage).kind === 'event' &&
      typeof (value as BridgeEventMessage).streamId === 'string',
  );
}

