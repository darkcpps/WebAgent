import * as vscode from 'vscode';
import { PlaywrightWebProvider } from './playwrightBase';

export class ChatGPTWebAdapter extends PlaywrightWebProvider {
  constructor(context: vscode.ExtensionContext) {
    super('chatgpt', context);
  }
}
