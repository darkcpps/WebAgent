import * as vscode from 'vscode';
import { PlaywrightWebProvider } from './playwrightBase';

export class KimiWebAdapter extends PlaywrightWebProvider {
  constructor(context: vscode.ExtensionContext) {
    super('kimi', context);
  }
}
