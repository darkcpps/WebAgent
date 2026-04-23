import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright';
import * as vscode from 'vscode';
import type { ChatModel, ProviderId } from '../shared/types';
import type { ProviderAdapter, ProviderEvent, ProviderPrompt, ProviderReadiness } from './base';
import { selectorRegistry, type ProviderSelectorMap } from './selector-registry';
import { sanitizeResponse } from '../shared/utils';

type LaunchOptions = NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>;
type BrowserChannelSetting = 'auto' | 'chrome' | 'msedge' | 'chromium';
type SelectorGroup =
  | 'input'
  | 'submit'
  | 'assistantMessages'
  | 'modelPicker'
  | 'modelOption'
  | 'modelExpand'
  | 'newChat'
  | 'stopButton'
  | 'accountMenu'
  | 'signOut'
  | 'signIn';

export abstract class PlaywrightWebProvider implements ProviderAdapter {
  protected context?: BrowserContext;
  protected page?: Page;
  protected lastResponse = '';
  protected stopped = false;
  private launchedHeadless?: boolean;
  private pendingUserPrompt = '';
  private lastAssistantBeforeSend = '';

  readonly selectorMap: ProviderSelectorMap;
  private modelsCache: ChatModel[] = [{ id: 'auto', label: 'Auto' }];
  private selectorHints: Partial<Record<SelectorGroup, string[]>> = {};
  private readonly genericSelectors: Partial<Record<SelectorGroup, string[]>> = {
    input: ['textarea', '[contenteditable="true"]', '[role="textbox"]', 'div[contenteditable="true"][role="textbox"]'],
    submit: ['button[type="submit"]', 'button[aria-label*="Send"]', '[data-testid*="send"]'],
    assistantMessages: [
      '[data-message-author-role="assistant"]',
      '[data-role="assistant"]',
      '.assistant-message',
      '[class*="assistant"][class*="message"]',
    ],
    modelPicker: ['button[aria-label="Select a model"]', 'button[aria-label*="model"]', 'button[aria-label*="Model"]', '[role="combobox"]'],
    modelOption: ['button[aria-label="model-item"][data-value]', '[data-value]', '[role="option"]', '[role="menuitem"]'],
    modelExpand: ['button:has-text("More models")', 'button:has-text("Other models")', 'button:has-text("All models")', '[role="tab"]:has-text("Other models")'],
    newChat: ['button[aria-label*="New chat"]', 'a[href="/"]'],
    stopButton: ['button[aria-label*="Stop"]', '[data-testid*="stop"]'],
    accountMenu: ['button[aria-label*="Profile"]', 'button[aria-label*="Account"]', '[data-testid*="avatar"]'],
    signOut: ['text=Sign out', 'text=Log out'],
    signIn: ['text=Sign in', 'text=Log in'],
  };

  constructor(
    readonly id: ProviderId,
    private readonly extensionContext: vscode.ExtensionContext,
  ) {
    this.selectorMap = selectorRegistry[id];
    if (this.selectorMap.models.length > 0) {
      this.modelsCache = this.selectorMap.models;
    }
  }

  async login(): Promise<void> {
    const loginHeadless = this.id === 'zai' ? false : this.getRuntimeHeadlessMode();
    await this.withRecovery(async () => {
      await this.gotoHome();
      await vscode.window.showInformationMessage(
        `Finish logging in to ${this.id} in the opened browser window. Login state is saved for future sessions.`,
      );
    }, { headless: loginHeadless });
    if (this.id === 'zai' && this.getRuntimeHeadlessMode()) {
      console.log('[zai-managed] Login was opened in visible mode. Subsequent runtime will use headless mode.');
    }
  }

  async logout(): Promise<boolean> {
    return this.withRecovery(async () => {
      await this.gotoHome();

      let signOutButton = await this.findFirstVisible(this.getSelectors('signOut'), 1200);
      if (!signOutButton) {
        const accountMenu = await this.findFirstVisible(this.getSelectors('accountMenu'), 2000);
        if (accountMenu) {
          await accountMenu.click().catch(() => undefined);
          await this.page!.waitForTimeout(250);
          signOutButton = await this.findFirstVisible(this.getSelectors('signOut'), 2500);
        }
      }

      if (!signOutButton) {
        return false;
      }

      await signOutButton.click().catch(() => undefined);
      await this.page!.waitForTimeout(500);
      return true;
    });
  }

  listModels(): ChatModel[] {
    return this.modelsCache;
  }

  async refreshModels(): Promise<ChatModel[]> {
    return this.withRecovery(async () => {
      await this.gotoHome();
      const htmlFirstPass = await this.extractModelValuesFromHtml();
      if (htmlFirstPass.length > 0) {
        this.modelsCache = this.toModelList(htmlFirstPass);
        return this.modelsCache;
      }

      const modelPicker = await this.findFirstVisible(this.getSelectors('modelPicker'), 3500);
      if (!modelPicker) {
        return this.modelsCache;
      }

      await modelPicker.click().catch(() => undefined);
      await this.page!.waitForTimeout(300);
      await this.expandModelOptions();

      const selectorList = this.getSelectors('modelOption');
      const extracted = await this.extractVisibleOptionLabels(selectorList, 3000);
      await this.page!.keyboard.press('Escape').catch(() => undefined);

      if (extracted.length > 0) {
        this.modelsCache = this.toModelList(extracted);
      }

      return this.modelsCache;
    });
  }

  async selectModel(modelId: string): Promise<boolean> {
    if (!modelId || modelId === 'auto') {
      return true;
    }

    return this.withRecovery(async () => {
      await this.ensureConversationContext();

      let modelPicker = await this.findFirstVisible(this.getSelectors('modelPicker'), 4500);
      if (!modelPicker) {
        await this.gotoHome();
        modelPicker = await this.findFirstVisible(this.getSelectors('modelPicker'), 4500);
      }
      if (!modelPicker) {
        return false;
      }

      const currentLabel = (await modelPicker.innerText().catch(() => '')).toLowerCase();
      if (currentLabel.includes(modelId.toLowerCase())) {
        return true;
      }

      if (await modelPicker.isDisabled()) {
        return currentLabel.includes(modelId.toLowerCase());
      }

      await modelPicker.click().catch(() => undefined);
      await this.page!.waitForTimeout(250);
      await this.expandModelOptions();

      const exactValue = this.page!
        .locator(`button[aria-label="model-item"][data-value="${this.escapeAttributeValue(modelId)}"], [data-value="${this.escapeAttributeValue(modelId)}"]`)
        .first();

      let modelOption: Locator | undefined;
      if ((await exactValue.count()) > 0) {
        try {
          if (await exactValue.isVisible()) {
            modelOption = exactValue;
          }
        } catch {
          // Ignore and fallback to text match.
        }
      }

      if (!modelOption) {
        modelOption = await this.findVisibleOptionByText(this.getSelectors('modelOption'), modelId, 3500);
      }
      if (!modelOption) {
        await this.page!.keyboard.press('Escape').catch(() => undefined);
        return false;
      }

      await modelOption.click().catch(() => undefined);
      await this.page!.waitForTimeout(250);

      const selectedByAttr = this.page!
        .locator(`button[aria-label="model-item"][data-selected="true"][data-value="${this.escapeAttributeValue(modelId)}"]`)
        .first();
      if ((await selectedByAttr.count()) > 0) {
        return true;
      }

      const pickerLabel = (await modelPicker.innerText().catch(() => '')).toLowerCase();
      return pickerLabel.includes(modelId.toLowerCase());
    });
  }

  async checkReady(): Promise<ProviderReadiness> {
    return this.withRecovery(async () => {
      await this.ensureConversationContext();
      const input = await this.findFirstVisible(this.getSelectors('input'), 5000);
      if (input) {
        return { ready: true, loginRequired: false };
      }

      const signIn = await this.findFirstVisible(this.getSelectors('signIn'), 1200);
      if (signIn) {
        return { ready: false, loginRequired: true };
      }

      return { ready: false, loginRequired: false };
    });
  }

  async startNewConversation(): Promise<string | undefined> {
    return this.withRecovery(async () => {
      await this.gotoHome();
      const newChatButton = await this.findFirstVisible(this.getSelectors('newChat'), 3500);
      await newChatButton?.click().catch(() => undefined);
      await this.page!.waitForTimeout(400);
      return this.parseConversationIdFromUrl(this.page!.url());
    });
  }

  async openConversation(conversationId: string): Promise<boolean> {
    if (!conversationId.trim()) {
      return false;
    }

    return this.withRecovery(async () => {
      const target = this.buildConversationUrl(conversationId);
      if (!target) {
        return false;
      }
      await this.page!.goto(target, { waitUntil: 'domcontentloaded' });
      await this.refreshSelectorHintsFromHtml();
      return this.parseConversationIdFromUrl(this.page!.url()) === conversationId;
    });
  }

  async getCurrentConversationId(): Promise<string | undefined> {
    return this.withRecovery(async () => {
      await this.ensureConversationContext();
      return this.parseConversationIdFromUrl(this.page!.url());
    });
  }

  async deleteConversation(conversationId: string): Promise<boolean> {
    if (!conversationId.trim()) {
      return false;
    }

    return this.withRecovery(async () => {
      const opened = await this.openConversation(conversationId);
      if (!opened) {
        return false;
      }

      const openMenuCandidates = [
        'button[aria-label*="More"]',
        'button[aria-label*="more"]',
        'button[data-state][aria-haspopup]',
      ];

      for (const selector of openMenuCandidates) {
        const menuButton = await this.findFirstVisible([selector], 600);
        await menuButton?.click().catch(() => undefined);
      }

      const deleteCandidates = [
        'button:has-text("Delete chat")',
        'button:has-text("Delete conversation")',
        'button:has-text("Delete")',
        '[role="menuitem"]:has-text("Delete chat")',
        '[role="menuitem"]:has-text("Delete conversation")',
        '[role="menuitem"]:has-text("Delete")',
      ];

      const deleteButton = await this.findFirstVisible(deleteCandidates, 2000);
      if (!deleteButton) {
        return false;
      }
      await deleteButton.click().catch(() => undefined);
      await this.page!.waitForTimeout(200);

      const confirmCandidates = [
        'button:has-text("Delete")',
        'button:has-text("Confirm")',
        'button:has-text("Yes")',
      ];
      const confirmButton = await this.findFirstVisible(confirmCandidates, 1500);
      await confirmButton?.click().catch(() => undefined);
      await this.page!.waitForTimeout(500);

      return this.parseConversationIdFromUrl(this.page!.url()) !== conversationId;
    });
  }

  async isReady(): Promise<boolean> {
    const readiness = await this.checkReady();
    return readiness.ready;
  }

  async sendPrompt(input: ProviderPrompt): Promise<void> {
    await this.withRecovery(async () => {
      await this.ensureConversationContext();
      this.stopped = false;
      this.lastResponse = '';

      let composer = await this.findFirstVisible(this.getSelectors('input'), 9000);
      if (!composer) {
        await this.page!.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
        await this.refreshSelectorHintsFromHtml();
        composer = await this.findFirstVisible(this.getSelectors('input'), 5000);
      }
      if (!composer) {
        throw new Error(`Unable to find input box for provider ${this.id}.`);
      }

      const fullPrompt = [input.systemPrompt?.trim(), input.userPrompt?.trim()].filter(Boolean).join('\n\n');
      this.pendingUserPrompt = input.userPrompt.trim();
      this.lastAssistantBeforeSend = (await this.readAssistantTextFromDomSnapshot()).trim();
      
      await composer.focus();
      await composer.click();
      await this.page!.waitForTimeout(120);

      const wrotePrompt = await this.writePromptWithFallback(composer, fullPrompt);
      if (!wrotePrompt) {
        throw new Error(`Unable to insert prompt text for provider ${this.id}.`);
      }

      // Small pause to let UI react
      await this.page!.waitForTimeout(220);

      const submitButton = await this.findFirstVisible(this.getSelectors('submit'), 4000);
      if (submitButton) {
        // Double check if enabled
        if (await submitButton.isEnabled()) {
          await submitButton.click().catch(() => undefined);
          return;
        }
      }
      
      // Fallback to Enter if button not found or disabled
      await this.page!.keyboard.press('Enter');
    });
  }

  async streamEvents(onEvent: (event: ProviderEvent) => void): Promise<void> {
    await this.ensurePage();
    const start = Date.now();
    let stableTicks = 0;
    let lastDelivered = '';

    onEvent({ type: 'status', message: `Waiting for ${this.id} response...` });
    let lastCid = '';

    while (!this.stopped) {
      try {
        const cid = this.parseConversationIdFromUrl(this.page!.url());
        if (cid && cid !== lastCid) {
          lastCid = cid;
          onEvent({ type: 'metadata', conversationId: cid });
        }
        await this.page!.waitForTimeout(1200);
      } catch (error) {
        if (this.isClosedTargetError(error)) {
          onEvent({ type: 'error', message: `${this.id} browser window was closed. Click Login to reopen it.` });
          await this.resetBrowserState();
          return;
        }
        throw error;
      }

      const text = await this.readAssistantText();
      if (text && text !== lastDelivered) {
        let delta = '';
        if (text.startsWith(lastDelivered)) {
          delta = text.slice(lastDelivered.length);
        } else if (lastDelivered === '') {
          delta = text;
        } else if (text.length > lastDelivered.length) {
          delta = text.slice(lastDelivered.length);
        }
        if (delta) {
          onEvent({ type: 'delta', text: delta });
        }
        lastDelivered = text;
        stableTicks = 0;
      } else {
        stableTicks += 1;
      }

      const stillGenerating = await this.isGenerating();
      if (!stillGenerating && stableTicks >= 3 && lastDelivered.trim()) {
        this.lastResponse = lastDelivered;
        onEvent({ type: 'done', fullText: lastDelivered });
        return;
      }

      if (!stillGenerating && stableTicks >= 12 && !lastDelivered.trim()) {
        const fallbackText = (await this.readAssistantTextFromDomSnapshot()) || (await this.readAssistantTextFromHeuristicSnapshot());
        if (fallbackText.trim()) {
          this.lastResponse = fallbackText;
          onEvent({ type: 'done', fullText: fallbackText });
          return;
        }

        if (stableTicks % 5 === 0) {
          onEvent({ type: 'status', message: `Still waiting for ${this.id} response to appear in DOM...` });
        }
      }

      if (Date.now() - start > 240000) {
        onEvent({ type: 'error', message: `${this.id} timed out while streaming a response.` });
        return;
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.page && this.selectorMap.stopButton) {
      const stopButton = await this.findFirstVisible(this.getSelectors('stopButton'), 1000);
      await stopButton?.click().catch(() => undefined);
    }
  }

  async resetConversation(): Promise<void> {
    await this.startNewConversation();
    this.lastResponse = '';
  }

  protected async ensurePage(headless?: boolean): Promise<void> {
    const desiredHeadless = headless ?? this.getRuntimeHeadlessMode();
    if (this.context?.isClosed()) {
      this.context = undefined;
      this.page = undefined;
      this.launchedHeadless = undefined;
    }
    if (this.page?.isClosed()) {
      this.page = undefined;
    }

    if (this.context && this.launchedHeadless !== desiredHeadless) {
      await this.resetBrowserState();
    }

    if (!this.context) {
      const userDataDir = this.resolveProfileDir();
      await fs.promises.mkdir(userDataDir, { recursive: true });
      this.context = await this.launchContextWithFallback(userDataDir, desiredHeadless);
      this.launchedHeadless = desiredHeadless;
      console.log(`[${this.id}-managed] Launching browser context in ${desiredHeadless ? 'headless' : 'visible'} mode.`);
      this.context.on('close', () => {
        this.context = undefined;
        this.page = undefined;
        this.launchedHeadless = undefined;
      });
    }
    if (!this.page) {
      this.page = this.pickBestPage(this.context.pages()) ?? (await this.context.newPage());
      this.page.on('close', () => {
        this.page = undefined;
      });
    } else {
      const preferred = this.pickBestPage(this.context.pages());
      if (preferred && preferred !== this.page) {
        this.page = preferred;
      }
    }
  }

  protected getLaunchOptions(headless: boolean, channel?: LaunchOptions['channel']): LaunchOptions {
    const options: LaunchOptions = {
      headless,
      viewport: { width: 1440, height: 960 },
      args: ['--disable-blink-features=AutomationControlled'],
      ignoreDefaultArgs: ['--enable-automation'],
    };
    if (channel) {
      options.channel = channel;
    }
    return options;
  }

  private async withRecovery<T>(operation: () => Promise<T>, options?: { headless?: boolean }): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await this.ensurePage(options?.headless);
      try {
        return await operation();
      } catch (error) {
        if (this.isClosedTargetError(error)) {
          lastError = error;
          await this.resetBrowserState();
          continue;
        }
        throw error;
      }
    }

    const fallbackMessage = `Browser session for ${this.id} was closed. Click Login and try again.`;
    throw new Error(lastError instanceof Error ? `${fallbackMessage} (${lastError.message})` : fallbackMessage);
  }

  private async gotoHome(): Promise<void> {
    await this.page!.goto(this.selectorMap.homeUrl, { waitUntil: 'domcontentloaded' });
    await this.refreshSelectorHintsFromHtml();
  }

  private async ensureConversationContext(): Promise<void> {
    const currentUrl = this.page!.url();
    const homeOrigin = new URL(this.selectorMap.homeUrl).origin;

    if (!currentUrl || currentUrl === 'about:blank' || !currentUrl.startsWith(homeOrigin)) {
      await this.gotoHome();
      return;
    }

    await this.refreshSelectorHintsFromHtml();
  }

  private async refreshSelectorHintsFromHtml(): Promise<void> {
    try {
      const html = await this.page!.content();
      const hints: Partial<Record<SelectorGroup, string[]>> = {};
      const add = (group: SelectorGroup, selector: string) => {
        const current = hints[group] ?? [];
        hints[group] = current.includes(selector) ? current : [...current, selector];
      };

      if (/id=["']prompt-textarea["']/i.test(html)) add('input', '#prompt-textarea');
      if (/data-testid=["'][^"']*composer-input[^"']*["']/i.test(html)) add('input', '[data-testid*="composer-input"] textarea');
      if (/contenteditable=["']true["']/i.test(html)) add('input', '[contenteditable="true"]');
      if (/<textarea/i.test(html)) add('input', 'textarea');

      if (/type=["']submit["']/i.test(html)) add('submit', 'button[type="submit"]');
      if (/aria-label=["'][^"']*send[^"']*["']/i.test(html)) add('submit', 'button[aria-label*="Send"]');
      if (/data-testid=["'][^"']*send[^"']*["']/i.test(html)) add('submit', '[data-testid*="send"]');

      if (/data-message-author-role=["']assistant["']/i.test(html)) add('assistantMessages', '[data-message-author-role="assistant"]');
      if (/data-role=["']assistant["']/i.test(html)) add('assistantMessages', '[data-role="assistant"]');
      if (/assistant-message/i.test(html)) add('assistantMessages', '.assistant-message');

      if (/aria-label=["'][^"']*model[^"']*["']/i.test(html)) add('modelPicker', 'button[aria-label*="Model"]');
      if (/aria-label=["']Select a model["']/i.test(html)) add('modelPicker', 'button[aria-label="Select a model"]');
      if (/role=["']combobox["']/i.test(html)) add('modelPicker', '[role="combobox"]');
      if (/role=["']option["']/i.test(html)) add('modelOption', '[role="option"]');
      if (/role=["']menuitem["']/i.test(html)) add('modelOption', '[role="menuitem"]');
      if (/aria-label=["']model-item["'][^>]*data-value=/i.test(html)) add('modelOption', 'button[aria-label="model-item"][data-value]');
      if (/more models|other models|all models/i.test(html)) add('modelExpand', 'button:has-text("More models")');

      if (/aria-label=["'][^"']*new chat[^"']*["']/i.test(html)) add('newChat', 'button[aria-label*="New chat"]');
      if (/data-testid=["'][^"']*stop[^"']*["']/i.test(html)) add('stopButton', '[data-testid*="stop"]');
      if (/aria-label=["'][^"']*stop[^"']*["']/i.test(html)) add('stopButton', 'button[aria-label*="Stop"]');

      this.selectorHints = hints;
    } catch {
      // Ignore parsing failures and keep existing selectors.
    }
  }

  private getSelectors(group: SelectorGroup): string[] {
    const mapped = this.selectorMap[group] ?? [];
    const hinted = this.selectorHints[group] ?? [];
    const generic = this.genericSelectors[group] ?? [];
    return [...new Set([...hinted, ...mapped, ...generic])];
  }

  private resolveProfileDir(): string {
    const stableProfileDir = path.join(os.homedir(), '.webagent-code', 'playwright-state', this.id);
    const legacyProfileDir = path.join(this.extensionContext.globalStorageUri.fsPath, 'playwright-state', this.id);

    if (fs.existsSync(stableProfileDir) || !fs.existsSync(legacyProfileDir)) {
      return stableProfileDir;
    }

    return legacyProfileDir;
  }

  private async launchContextWithFallback(userDataDir: string, headless: boolean): Promise<BrowserContext> {
    const channels = this.getLaunchChannelOrder();
    let lastError: unknown;

    for (const channel of channels) {
      const options = this.getLaunchOptions(headless, channel);
      try {
        return await chromium.launchPersistentContext(userDataDir, options);
      } catch (error) {
        lastError = error;
        if (!channel) {
          break;
        }
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[${this.id}-managed] Browser channel "${channel}" unavailable (${message}). Falling back...`);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(`Failed to launch browser context for ${this.id}.`);
  }

  private getLaunchChannelOrder(): Array<LaunchOptions['channel'] | undefined> {
    const configured = vscode.workspace
      .getConfiguration('webagentCode')
      .get<BrowserChannelSetting>('playwright.browserChannel', 'auto');

    if (configured === 'chrome') {
      return ['chrome', undefined];
    }
    if (configured === 'msedge') {
      return ['msedge', undefined];
    }
    if (configured === 'chromium') {
      return [undefined];
    }

    // Providers that often trigger strict auth checks do better with branded channels.
    if (this.id === 'perplexity' || this.id === 'gemini') {
      return ['chrome', 'msedge', undefined];
    }
    return [undefined];
  }

  private pickBestPage(pages: Page[]): Page | undefined {
    if (!pages.length) {
      return undefined;
    }

    const homeOrigin = new URL(this.selectorMap.homeUrl).origin;
    const matching = pages.find((page) => {
      try {
        return page.url().startsWith(homeOrigin);
      } catch {
        return false;
      }
    });

    if (matching) {
      return matching;
    }

    return pages.find((page) => page.url() && page.url() !== 'about:blank') ?? pages[0];
  }

  private async resetBrowserState(): Promise<void> {
    const context = this.context;
    this.context = undefined;
    this.page = undefined;
    this.selectorHints = {};
    this.launchedHeadless = undefined;
    if (context && !context.isClosed()) {
      await context.close().catch(() => undefined);
    }
  }

  protected getRuntimeHeadlessMode(): boolean {
    if (this.id !== 'zai') {
      return false;
    }
    const configured = vscode.workspace.getConfiguration('webagentCode').get<string>('zai.runtimeMode', 'headless');
    return configured !== 'visible';
  }

  private isClosedTargetError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /Target page, context or browser has been closed|Browser has been closed|has been closed/i.test(message);
  }

  private async findFirstVisible(selectors: string[], timeoutMs: number): Promise<Locator | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const selector of selectors) {
        const locator = this.page!.locator(selector).first();
        if ((await locator.count()) > 0) {
          try {
            if (await locator.isVisible()) {
              return locator;
            }
          } catch (error) {
            if (this.isClosedTargetError(error)) {
              return undefined;
            }
          }
        }
      }
      await this.page!.waitForTimeout(250).catch(() => undefined);
    }
    return undefined;
  }

  private async findVisibleOptionByText(selectors: string[], text: string, timeoutMs: number): Promise<Locator | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const selector of selectors) {
        const exact = this.page!.locator(selector).filter({ hasText: text }).first();
        if ((await exact.count()) > 0) {
          try {
            if (await exact.isVisible()) {
              return exact;
            }
          } catch {
            // Ignore transient DOM issues.
          }
        }

        const candidates = this.page!.locator(selector);
        const count = await candidates.count();
        for (let index = 0; index < count; index += 1) {
          const candidate = candidates.nth(index);
          try {
            const label = (await candidate.innerText()).trim().toLowerCase();
            if (label.includes(text.toLowerCase()) && (await candidate.isVisible())) {
              return candidate;
            }
          } catch {
            // Ignore transient DOM issues.
          }
        }
      }
      await this.page!.waitForTimeout(200).catch(() => undefined);
    }
    return undefined;
  }

  private async writePromptWithFallback(composer: Locator, fullPrompt: string): Promise<boolean> {
    await this.clearComposer(composer);

    if (await this.tryFastComposerWrite(composer, fullPrompt)) {
      return true;
    }

    // Last-resort typing can fire Enter key handlers on multiline prompts.
    if (!fullPrompt.includes('\n')) {
      await composer.pressSequentially(fullPrompt, { delay: 1 }).catch(() => undefined);
      if (await this.composerContainsPrompt(composer, fullPrompt)) {
        return true;
      }
    }

    await composer.fill(fullPrompt).catch(() => undefined);
    return this.composerContainsPrompt(composer, fullPrompt);
  }

  private async clearComposer(composer: Locator): Promise<void> {
    await composer.fill('').catch(() => undefined);

    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await this.page!.keyboard.press(`${modifier}+A`).catch(() => undefined);
    await this.page!.keyboard.press('Backspace').catch(() => undefined);
  }

  private async tryFastComposerWrite(composer: Locator, fullPrompt: string): Promise<boolean> {
    const attempts: Array<() => Promise<void>> = [
      async () => {
        await composer.fill(fullPrompt);
      },
      async () => {
        await composer.focus();
        await this.page!.keyboard.insertText(fullPrompt);
      },
      async () => {
        await this.page!.evaluate((value) => {
          const el = document.activeElement as HTMLElement | null;
          if (!el) {
            return;
          }

          if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
            el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return;
          }

          if (el.isContentEditable) {
            el.textContent = value;
            el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, fullPrompt);
      },
    ];

    for (const attempt of attempts) {
      await this.clearComposer(composer);
      await attempt().catch(() => undefined);
      await this.page!.waitForTimeout(60).catch(() => undefined);
      if (await this.composerContainsPrompt(composer, fullPrompt)) {
        return true;
      }
    }

    return false;
  }

  private async composerContainsPrompt(composer: Locator, fullPrompt: string): Promise<boolean> {
    const expected = fullPrompt.trim();
    if (!expected) {
      return true;
    }

    try {
      const actualRaw = await composer.evaluate((node) => {
        if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
          return node.value || '';
        }
        return (node.textContent || '').trim();
      });

      const actual = actualRaw.replace(/\s+/g, ' ').trim();
      const probe = expected.slice(0, Math.min(96, expected.length)).replace(/\s+/g, ' ').trim();

      return actual.length >= Math.min(24, expected.length) && actual.includes(probe);
    } catch {
      return false;
    }
  }

  private async extractVisibleOptionLabels(selectors: string[], timeoutMs: number): Promise<string[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const labels = new Set<string>();
      for (const selector of selectors) {
        const options = this.page!.locator(selector);
        const count = await options.count();
        for (let index = 0; index < count; index += 1) {
          const option = options.nth(index);
          try {
            if (!(await option.isVisible())) {
              continue;
            }
            const dataValue = (await option.getAttribute('data-value'))?.trim();
            const textRaw = dataValue || (await option.innerText()).trim();
            const text = this.normalizeModelLabel(textRaw);
            if (text.length < 2 || text.length > 80) {
              continue;
            }
            if (/new chat|settings|help|theme|logout|log out|upgrade$/i.test(text)) {
              continue;
            }
            labels.add(text);
          } catch {
            // Ignore transient DOM issues.
          }
        }
      }
      if (labels.size > 0) {
        return [...labels].slice(0, 40);
      }
      await this.page!.waitForTimeout(150).catch(() => undefined);
    }
    return [];
  }

  private async readAssistantText(): Promise<string> {
    const snapshot = await this.readAssistantTextFromDomSnapshot();
    if (snapshot) {
      return snapshot;
    }

    for (const selector of this.getSelectors('assistantMessages')) {
      const locator = this.page!.locator(selector);
      const count = await locator.count();
      if (count > 0) {
        const last = locator.nth(count - 1);
        try {
          const text = await last.innerText();
          const cleaned = this.sanitizeAssistantText(text);
          if (cleaned) {
            return cleaned;
          }
        } catch {
          // Continue.
        }
      }
    }
    return '';
  }

  private async readAssistantTextFromDomSnapshot(): Promise<string> {
    try {
      const selectors = this.getSelectors('assistantMessages');
      const text = await this.page!.evaluate((selectorParams) => {
        const selector = selectorParams.join(',');

        const stripNoise = (node: HTMLElement): string => {
          const clone = node.cloneNode(true) as HTMLElement;
          const noiseSelectors = [
            '.thinking-chain-container',
            '.thinking-block',
            '.thinking',
            '.thought',
            '[class*="thinking"]',
            '[class*="thought"]',
            '[data-thinking]',
            '[data-testid*="thinking"]',
            '[aria-label*="Thought"]',
            'thought',
            'think',
            'button',
          ];

          for (const noise of noiseSelectors) {
            for (const el of Array.from(clone.querySelectorAll<HTMLElement>(noise))) {
              el.remove();
            }
          }

          return (clone.innerText || '').trim();
        };

        const nodes = Array.from(document.querySelectorAll<HTMLElement>(selector));
        const banned = /(new chat|more models|settings|sync|login|send|free ai chatbot|agent powered by|powered by glm|chat with z.ai)/i;
        const candidates = nodes
          .map((node) => {
            const rect = node.getBoundingClientRect();
            const value = stripNoise(node);
            // Ignore if it matches banned text exactly or is a very short fragment of it
            if (banned.test(value.toLowerCase())) return { node, value: '', top: 0, bottom: 0, priority: -1 };
            
            const priority = /"actions"\s*:|"summary"\s*:|```json/i.test(value) ? 10 : 0;
            return { node, value, top: rect.top, bottom: rect.bottom, priority };
          })
          .filter((item) => item.value.length >= 2 && item.bottom > 0);

        if (!candidates.length) {
          return '';
        }

        candidates.sort((a, b) => b.priority - a.priority || b.top - a.top || b.value.length - a.value.length);
        const targetNode = candidates[0].node;
        let output = candidates[0].value;

        const blocks = targetNode
          ? Array.from(
              targetNode.querySelectorAll<HTMLElement>('[data-language], .language-python, .language-javascript, .language-typescript'),
            )
          : [];
        const renderedBlocks = blocks
          .map((block) => {
            const lang =
              (block.getAttribute('data-language') || '')
                .toLowerCase()
                .trim() ||
              Array.from(block.classList)
                .find((c) => c.startsWith('language-'))
                ?.replace('language-', '') ||
              '';

            const cmLines = Array.from(block.querySelectorAll<HTMLElement>('.cm-content .cm-line'))
              .map((line) => line.innerText || '')
              .join('\n')
              .trim();

            const fallback = (block.innerText || '').trim();
            const code = (cmLines || fallback)
              .split(/\r?\n/)
              .filter((line) => !/^\s*(copy|python|javascript|typescript)\s*$/i.test(line.trim()))
              .join('\n')
              .trim();

            if (!code) {
              return '';
            }

            return `\`\`\`${lang}\n${code}\n\`\`\``.trim();
          })
          .filter(Boolean);

        if (renderedBlocks.length > 0 && !output.includes('```')) {
          output = `${output}\n\n${renderedBlocks.join('\n\n')}`.trim();
        }

        return output;
      }, selectors);
      return this.sanitizeAssistantText(text);
    } catch {
      return '';
    }
  }

  private async readAssistantTextFromHeuristicSnapshot(): Promise<string> {
    try {
      const text = await this.page!.evaluate(() => {
        const candidates: string[] = [];
        const selectors = [
          '[class*="assistant"]',
          '[data-role="assistant"]',
          '[data-message-author-role="assistant"]',
          '[class*="message-assistant"]',
          '[class*="message_assistant"]',
          '[class*="prose"]',
          '.markdown',
          'p',
          'pre',
          'div',
        ];

        const banned = /(new chat|more models|settings|sync|login|send|model|chatui|agent mode|sign out|sign in)/i;
        for (const selector of selectors) {
          const nodes = Array.from(document.querySelectorAll<HTMLElement>(selector));
          for (const node of nodes) {
            const rect = node.getBoundingClientRect();
            if (rect.bottom <= 0 || rect.top >= window.innerHeight + 400) {
              continue;
            }
            const value = (node.innerText || '').trim();
            if (!value || value.length < 3) {
              continue;
            }
            if (banned.test(value)) {
              continue;
            }
            candidates.push(value);
          }
        }

        const uniq = Array.from(new Set(candidates));
        return uniq.slice(-8).reverse();
      });

      for (const candidate of text) {
        const cleaned = this.sanitizeAssistantText(candidate);
        if (cleaned) {
          return cleaned;
        }
      }

      return '';
    } catch {
      return '';
    }
  }

  private async getDomDebugSummary(): Promise<string> {
    try {
      const summary = await this.page!.evaluate((selectors) => {
        const count = (selector: string) => document.querySelectorAll(selector).length;
        const peek = (selector: string) =>
          Array.from(document.querySelectorAll<HTMLElement>(selector))
            .slice(-2)
            .map((node) => (node.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 120))
            .filter(Boolean);

        return {
          url: location.href,
          input: selectors.input.map((s) => `${s}:${count(s)}`),
          submit: selectors.submit.map((s) => `${s}:${count(s)}`),
          assistant: selectors.assistant.map((s) => `${s}:${count(s)}`),
          assistantPeek: selectors.assistant.flatMap((s) => peek(s)).slice(-3),
          mainPeek: peek('main div').slice(-3),
        };
      }, {
        input: this.getSelectors('input'),
        submit: this.getSelectors('submit'),
        assistant: this.getSelectors('assistantMessages'),
      });

      return JSON.stringify(summary);
    } catch (error) {
      return `DOM debug failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private async extractModelValuesFromHtml(): Promise<string[]> {
    try {
      const html = await this.page!.content();
      const regexValues = [...html.matchAll(/aria-label=["']model-item["'][^>]*data-value=["']([^"']+)["']/gi)]
        .map((match) => (match[1] || '').trim())
        .filter(Boolean);

      if (regexValues.length > 0) {
        return [...new Set(regexValues.map((value) => this.normalizeModelLabel(value)).filter(Boolean))].slice(0, 48);
      }

      const values = await this.page!.evaluate(() => {
        const fromModelItems = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label="model-item"][data-value]'))
          .map((node) => node.getAttribute('data-value') || '')
          .map((value) => value.trim())
          .filter(Boolean);

        if (fromModelItems.length > 0) {
          return fromModelItems;
        }

        return Array.from(document.querySelectorAll<HTMLElement>('[data-value]'))
          .map((node) => node.getAttribute('data-value') || '')
          .map((value) => value.trim())
          .filter((value) => /^[A-Za-z0-9][A-Za-z0-9._\-]{1,40}$/.test(value));
      });

      return [...new Set(values.map((value) => this.normalizeModelLabel(value)).filter(Boolean))].slice(0, 48);
    } catch {
      return [];
    }
  }

  private async expandModelOptions(): Promise<void> {
    for (const selector of this.getSelectors('modelExpand')) {
      const trigger = await this.findFirstVisible([selector], 300);
      if (!trigger) {
        continue;
      }
      await trigger.click().catch(() => undefined);
      await this.page!.waitForTimeout(250).catch(() => undefined);
    }
  }

  private normalizeModelLabel(value: string): string {
    const cleaned = value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ');
    if (!cleaned) {
      return '';
    }
    const normalized = cleaned
      .replace(/\b(currently selected|selected|recommended)\b/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (!normalized) {
      return '';
    }
    return normalized.replace(/\b([v])(\d+)/g, (_, prefix, digits) => `${prefix.toUpperCase()}${digits}`);
  }

  private toModelList(values: string[]): ChatModel[] {
    const deduped = new Map<string, ChatModel>();
    for (const value of values) {
      const label = this.normalizeModelLabel(value);
      if (!label) {
        continue;
      }
      const id = label;
      const key = id.toLowerCase();
      if (!deduped.has(key)) {
        deduped.set(key, { id, label });
      }
    }
    return [{ id: 'auto', label: 'Auto' }, ...deduped.values()];
  }

  private escapeAttributeValue(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  private parseConversationIdFromUrl(url: string): string | undefined {
    const match = url.match(/\/c\/([A-Za-z0-9-]{8,})/);
    return match?.[1];
  }

  private buildConversationUrl(conversationId: string): string | undefined {
    const base = this.selectorMap.homeUrl.replace(/\/+$/, '');
    if (!conversationId) {
      return undefined;
    }
    return `${base}/c/${conversationId}`;
  }

  private sanitizeAssistantText(raw: string): string {
    const text = sanitizeResponse(raw);

    if (this.isLikelyEcho(text)) {
      return '';
    }

    return text;
  }

  private isLikelyEcho(text: string): boolean {
    const normalized = text.trim().replace(/\s+/g, ' ').toLowerCase();
    if (!normalized) {
      return true;
    }
    const prompt = this.pendingUserPrompt.trim().replace(/\s+/g, ' ').toLowerCase();
    if (prompt && normalized === prompt) {
      return true;
    }
    const previous = this.lastAssistantBeforeSend.trim().replace(/\s+/g, ' ').toLowerCase();
    if (previous && normalized === previous) {
      return true;
    }
    return false;
  }

  private async isGenerating(): Promise<boolean> {
    const stopButton = await this.findFirstVisible(this.getSelectors('stopButton'), 250);
    return Boolean(stopButton);
  }
}
