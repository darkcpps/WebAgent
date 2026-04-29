import * as vscode from 'vscode';
import { PlaywrightWebProvider } from './playwrightBase';

export class DeepSeekWebAdapter extends PlaywrightWebProvider {
  constructor(context: vscode.ExtensionContext) {
    super('deepseek', context);
  }
}
