import * as vscode from 'vscode';
import { PlaywrightWebProvider } from './playwrightBase';

export class ZAIWebAdapter extends PlaywrightWebProvider {
  constructor(context: vscode.ExtensionContext) {
    super('zai', context);
  }

  protected override getLaunchOptions(headless: boolean) {
    const base = super.getLaunchOptions(headless);
    return {
      ...base,
      channel: 'chrome',
      args: [...(base.args ?? []), '--disable-blink-features=AutomationControlled'],
    };
  }
}
