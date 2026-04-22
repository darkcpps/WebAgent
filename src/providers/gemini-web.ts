import * as vscode from 'vscode';
import { PlaywrightWebProvider } from './playwrightBase';

export class GeminiWebAdapter extends PlaywrightWebProvider {
  constructor(context: vscode.ExtensionContext) {
    super('gemini', context);
  }
}
