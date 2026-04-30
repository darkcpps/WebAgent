import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright';
import * as vscode from 'vscode';
import type { ChatModel, ImageAttachment, ProviderId } from '../shared/types';
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

interface ComposerAttachmentState {
  matchedNames: string[];
  previewCount: number;
  uploading: boolean;
}

export abstract class PlaywrightWebProvider implements ProviderAdapter {
  protected context?: BrowserContext;
  protected page?: Page;
  protected lastResponse = '';
  protected stopped = false;
  private launchedHeadless?: boolean;
  private ensurePagePromise?: Promise<void>;
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
    modelOption: [
      'button[aria-label="model-item"][data-value]',
      '[data-value]',
      '[role="option"]',
      '[role="menuitem"]',
      '[role="menuitemradio"]',
      '[role="menuitemcheckbox"]',
    ],
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
    const isZaiProvider = (this.id as string) === 'zai';
    const loginHeadless = isZaiProvider ? false : this.getRuntimeHeadlessMode();
    await this.withRecovery(async () => {
      await this.gotoHome();
      await vscode.window.showInformationMessage(
        `Finish logging in to ${this.id} in the opened browser window. Login state is saved for future sessions.`,
      );
    }, { headless: loginHeadless });
    if (isZaiProvider && this.getRuntimeHeadlessMode()) {
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
      await this.waitForGenerationToSettleBeforeSend();

      let composer = await this.findBottomMostVisible(this.getSelectors('input'), 9000);
      if (!composer) {
        await this.page!.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
        await this.refreshSelectorHintsFromHtml();
        composer = await this.findBottomMostVisible(this.getSelectors('input'), 5000);
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

      await this.uploadImageAttachments(input.imageAttachments ?? []);

      // Small pause to let UI react
      await this.page!.waitForTimeout(220);

      const primarySubmitTimeoutMs = this.id === 'kimi' ? 500 : 5000;
      const fallbackSubmitTimeoutMs = this.id === 'kimi' ? 500 : 3000;

      if (await this.clickActiveComposerSubmit(composer)) {
        if (await this.waitForPromptSubmission(composer, fullPrompt, primarySubmitTimeoutMs)) {
          return;
        }
        if (this.id === 'kimi') {
          return;
        }
      }

      const submitButton = await this.findBottomMostEnabled(this.getSelectors('submit'), 8000);
      if (submitButton) {
        await submitButton.click().catch(() => undefined);
        if (await this.waitForPromptSubmission(composer, fullPrompt, primarySubmitTimeoutMs)) {
          return;
        }
        if (this.id === 'kimi') {
          return;
        }
      }

      // Fallbacks for composer variants where the visible button click does not
      // dispatch the same submit event as the keyboard shortcut.
      await this.page!.keyboard.press('Enter');
      if (await this.waitForPromptSubmission(composer, fullPrompt, fallbackSubmitTimeoutMs)) {
        return;
      }

      await this.page!.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter').catch(() => undefined);
      if (await this.waitForPromptSubmission(composer, fullPrompt, fallbackSubmitTimeoutMs)) {
        return;
      }

      await this.submitActiveComposerForm().catch(() => undefined);
      if (await this.waitForPromptSubmission(composer, fullPrompt, fallbackSubmitTimeoutMs)) {
        return;
      }

      throw new Error(`Unable to submit prompt for provider ${this.id}.`);
    });
  }

  async streamEvents(onEvent: (event: ProviderEvent) => void): Promise<void> {
    await this.ensurePage();
    const start = Date.now();
    let stableTicks = 0;
    let lastDelivered = '';
    const slowStreamingProvider = this.id === 'deepseek' || this.id === 'kimi';
    const requiredStableTicks = slowStreamingProvider ? 10 : 3;
    const emptyResponseStableTicks = slowStreamingProvider ? 24 : 12;

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
      if (!stillGenerating && stableTicks >= requiredStableTicks && lastDelivered.trim()) {
        this.lastResponse = lastDelivered;
        onEvent({ type: 'done', fullText: lastDelivered });
        return;
      }

      if (!stillGenerating && stableTicks >= emptyResponseStableTicks && !lastDelivered.trim()) {
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

  private async uploadImageAttachments(attachments: ImageAttachment[]): Promise<void> {
    if (attachments.length === 0) {
      return;
    }
    if (this.id !== 'chatgpt' && this.id !== 'perplexity') {
      throw new Error(`Image attachments are not supported for provider ${this.id}.`);
    }

    const payloads = attachments.map((attachment) => {
      const buffer = Buffer.from(attachment.data, 'base64');
      if (buffer.length === 0) {
        throw new Error(`Image attachment ${attachment.name || '(unnamed)'} is empty.`);
      }
      return {
        name: attachment.name || 'image.png',
        mimeType: attachment.mimeType || 'image/png',
        buffer,
      };
    });

    const beforeUpload = await this.readComposerAttachmentState(attachments);
    const uploaded =
      (await this.uploadViaFileChooser(payloads, attachments, beforeUpload).catch(() => false)) ||
      (await this.uploadViaFileInput(payloads, attachments, beforeUpload));
    if (!uploaded) {
      throw new Error(`Unable to attach image upload(s) for ${this.id}.`);
    }
  }

  private async uploadViaFileChooser(
    payloads: Array<{ name: string; mimeType: string; buffer: Buffer }>,
    attachments: ImageAttachment[],
    beforeUpload: ComposerAttachmentState,
  ): Promise<boolean> {
    const chooserPromise = this.page!.waitForEvent('filechooser', { timeout: 1800 }).catch(() => undefined);
    await this.clickAttachmentControl();
    const chooser = await chooserPromise;
    if (!chooser) {
      return false;
    }
    await chooser.setFiles(payloads);
    return this.waitForImageAttachmentsReady(attachments, beforeUpload);
  }

  private async uploadViaFileInput(
    payloads: Array<{ name: string; mimeType: string; buffer: Buffer }>,
    attachments: ImageAttachment[],
    beforeUpload: ComposerAttachmentState,
  ): Promise<boolean> {
    for (const input of await this.findUploadInputs()) {
      await input.setInputFiles(payloads).catch(() => undefined);
      if (await this.waitForImageAttachmentsReady(attachments, beforeUpload, 8000)) {
        return true;
      }
    }

    await this.clickAttachmentControl();
    await this.page!.waitForTimeout(350);
    for (const input of await this.findUploadInputs()) {
      await input.setInputFiles(payloads).catch(() => undefined);
      if (await this.waitForImageAttachmentsReady(attachments, beforeUpload, 12000)) {
        return true;
      }
    }

    return false;
  }

  private async findUploadInputs(): Promise<Locator[]> {
    const selectors =
      this.id === 'chatgpt'
        ? [
            'form input[type="file"][accept*="image"]',
            'form input[type="file"][accept*="png"]',
            'form input[type="file"][accept*="jpeg"]',
            'form input[type="file"][accept*="jpg"]',
            'main input[type="file"][accept*="image"]',
            'main input[type="file"]',
            'input[type="file"][accept*="image"]',
            'input[type="file"]',
          ]
        : [
            'input[type="file"][accept*="image"]',
            'input[type="file"][accept*="png"]',
            'input[type="file"][accept*="jpeg"]',
            'input[type="file"][accept*="jpg"]',
            'input[type="file"]',
          ];

    const inputs: Locator[] = [];
    const seen = new Set<string>();
    for (const selector of selectors) {
      const locator = this.page!.locator(selector);
      const count = await locator.count().catch(() => 0);
      for (let index = count - 1; index >= 0; index -= 1) {
        const input = locator.nth(index);
        const signature = await input
          .evaluate((node) => {
            const htmlInput = node as HTMLInputElement;
            const fileInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]'));
            const rect = htmlInput.getBoundingClientRect();
            return [
              fileInputs.indexOf(htmlInput),
              htmlInput.accept,
              htmlInput.name,
              htmlInput.id,
              Math.round(rect.top),
              Math.round(rect.left),
            ].join('|');
          })
          .catch(() => `${selector}|${index}`);
        if (!seen.has(signature)) {
          seen.add(signature);
          inputs.push(input);
        }
      }
    }

    return inputs;
  }

  private async clickAttachmentControl(): Promise<void> {
    const candidates = [
      'button[aria-label*="Upload image"]',
      'button[aria-label*="Add photos"]',
      'button[aria-label*="Add photo"]',
      'button[aria-label*="Attach files"]',
      'button[aria-label*="Attach"]',
      'button[aria-label*="Upload"]',
      'button[aria-label*="Add"]',
      'button[data-testid*="attach"]',
      'button[data-testid*="upload"]',
      'button[data-testid*="plus"]',
      'button:has-text("Attach")',
      'button:has-text("Upload")',
      'button:has-text("Add photos")',
      '[data-testid*="attach"]',
      '[data-testid*="upload"]',
    ];

    const button = await this.findBottomMostEnabled(candidates, 1800).catch(() => undefined);
    await button?.click().catch(() => undefined);
  }

  private async waitForImageAttachmentsReady(
    attachments: ImageAttachment[],
    beforeUpload: ComposerAttachmentState,
    timeoutMs = 20000,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let stableReadyTicks = 0;

    while (Date.now() < deadline) {
      const current = await this.readComposerAttachmentState(attachments);
      const hasNewPreview = current.previewCount > beforeUpload.previewCount;
      const hasExpectedName = current.matchedNames.length > 0;
      const uploadStarted = current.uploading || hasNewPreview || hasExpectedName;

      if (uploadStarted && !current.uploading) {
        stableReadyTicks += 1;
        if (stableReadyTicks >= 2) {
          return true;
        }
      } else {
        stableReadyTicks = 0;
      }

      await this.page!.waitForTimeout(400).catch(() => undefined);
    }

    return false;
  }

  private async readComposerAttachmentState(attachments: ImageAttachment[]): Promise<ComposerAttachmentState> {
    return this.page!
      .evaluate((attachmentNames) => {
        const isVisible = (element: Element): boolean => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };

        const roots = Array.from(document.querySelectorAll<HTMLElement>('form, main, [role="main"]')).filter(isVisible);
        const root =
          roots
            .map((candidate) => ({ candidate, rect: candidate.getBoundingClientRect() }))
            .filter((item) => item.rect.bottom > 0)
            .sort((a, b) => b.rect.bottom - a.rect.bottom)[0]?.candidate || document.body;

        const text = (root.innerText || '').toLowerCase();
        const normalizedNames = attachmentNames.map((name) => name.toLowerCase()).filter(Boolean);
        const matchedNames = normalizedNames.filter((name) => text.includes(name));
        const uploading =
          /uploading|attaching|processing|reading|scanning|preparing/i.test(text) ||
          Array.from(root.querySelectorAll('[role="progressbar"], progress')).some(isVisible);
        const previewCount = Array.from(root.querySelectorAll<HTMLImageElement>('img')).filter((image) => {
          const src = image.currentSrc || image.src || '';
          const label = `${image.alt || ''} ${image.title || ''}`.toLowerCase();
          return isVisible(image) && (src.startsWith('blob:') || src.startsWith('data:') || normalizedNames.some((name) => label.includes(name)));
        }).length;

        return { matchedNames, previewCount, uploading };
      }, attachments.map((attachment) => attachment.name || ''))
      .catch(() => ({ matchedNames: [], previewCount: 0, uploading: false }));
  }

  protected async ensurePage(headless?: boolean): Promise<void> {
    if (this.ensurePagePromise) {
      await this.ensurePagePromise;
      return;
    }

    const desiredHeadless = headless ?? this.getRuntimeHeadlessMode();
    this.ensurePagePromise = (async () => {
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
        const userDataDir = await this.resolveProfileDir();
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
      await this.closeExtraneousBlankPages().catch(() => undefined);
    })().finally(() => {
      this.ensurePagePromise = undefined;
    });

    await this.ensurePagePromise;
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
      if (/data-testid=["'][^"']*composer-input[^"']*["'][^>]*contenteditable=["']true["']/i.test(html)) add('input', '[data-testid*="composer-input"][contenteditable="true"]');
      if (/contenteditable=["']true["']/i.test(html)) add('input', '[contenteditable="true"]');
      if (/<textarea/i.test(html)) add('input', 'textarea');

      if (/type=["']submit["']/i.test(html)) add('submit', 'button[type="submit"]');
      if (/data-testid=["'][^"']*composer-submit[^"']*["']/i.test(html)) add('submit', '[data-testid*="composer-submit"]');
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
      if (/role=["']menuitemradio["']/i.test(html)) add('modelOption', '[role="menuitemradio"]');
      if (/role=["']menuitemcheckbox["']/i.test(html)) add('modelOption', '[role="menuitemcheckbox"]');
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

  private async resolveProfileDir(): Promise<string> {
    const stableProfileDir = path.join(os.homedir(), '.webagent-code', 'playwright-state', this.id);
    const legacyProfileDir = path.join(this.extensionContext.globalStorageUri.fsPath, 'playwright-state', this.id);

    if (!fs.existsSync(stableProfileDir) && fs.existsSync(legacyProfileDir)) {
      await this.copyProfileIfPresent(legacyProfileDir, stableProfileDir);
    }

    return stableProfileDir;
  }

  private async copyProfileIfPresent(sourceDir: string, targetDir: string): Promise<void> {
    try {
      await fs.promises.mkdir(path.dirname(targetDir), { recursive: true });
      await fs.promises.cp(sourceDir, targetDir, {
        recursive: true,
        force: false,
        errorOnExist: false,
        filter: (source) => !['SingletonLock', 'SingletonCookie', 'SingletonSocket'].includes(path.basename(source)),
      });
      console.log(`[${this.id}-managed] Migrated browser login profile to ${targetDir}.`);
    } catch (error) {
      console.warn(
        `[${this.id}-managed] Could not migrate legacy browser profile. A fresh persistent profile will be used. ${String(error)}`,
      );
    }
  }

  private async launchContextWithFallback(userDataDir: string, headless: boolean): Promise<BrowserContext> {
    const channels = this.getLaunchChannelOrder();
    let lastError: unknown;

    await this.cleanupStaleSingletonLocks(userDataDir);

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

    if (this.shouldRetryWithRecoveryProfile(lastError)) {
      await this.cleanupStaleSingletonLocks(userDataDir);
      console.warn(`[${this.id}-managed] Primary profile launch failed. Retrying primary profile after lock cleanup.`);
      await new Promise((resolve) => setTimeout(resolve, 180));

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
          console.warn(
            `[${this.id}-managed] Primary-profile retry failed for channel "${channel}" (${message}). Falling back...`,
          );
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error(`Failed to launch browser context for ${this.id}.`);
  }

  private shouldRetryWithRecoveryProfile(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /Opening in existing browser session|Target page, context or browser has been closed|Browser has been closed|profile|user data dir|singleton|already in use|processsingleton/i.test(
      message,
    );
  }

  private async cleanupStaleSingletonLocks(userDataDir: string): Promise<void> {
    const lockNames = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
    for (const lockName of lockNames) {
      const lockPath = path.join(userDataDir, lockName);
      try {
        await fs.promises.unlink(lockPath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (code && code !== 'ENOENT' && code !== 'EPERM' && code !== 'EACCES') {
          console.warn(`[${this.id}-managed] Unable to remove stale lock file ${lockPath}: ${String(error)}`);
        }
      }
    }
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
    if (this.id === 'perplexity' || this.id === 'kimi' || this.id === 'deepseek') {
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

  private async closeExtraneousBlankPages(): Promise<void> {
    if (!this.context || !this.page || this.context.isClosed() || this.page.isClosed()) {
      return;
    }

    for (const candidate of this.context.pages()) {
      if (candidate === this.page || candidate.isClosed()) {
        continue;
      }
      const url = candidate.url();
      if (url === 'about:blank') {
        await candidate.close().catch(() => undefined);
      }
    }
  }

  protected getRuntimeHeadlessMode(): boolean {
    if ((this.id as string) !== 'zai') {
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

  private async findFirstEnabled(selectors: string[], timeoutMs: number): Promise<Locator | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const candidate = await this.findFirstVisible(selectors, 500);
      if (candidate) {
        try {
          if (await candidate.isEnabled()) {
            return candidate;
          }
        } catch (error) {
          if (this.isClosedTargetError(error)) {
            return undefined;
          }
        }
      }
      await this.page!.waitForTimeout(200).catch(() => undefined);
    }
    return undefined;
  }

  private async findBottomMostVisible(selectors: string[], timeoutMs: number): Promise<Locator | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let best: { locator: Locator; bottom: number; x: number } | undefined;
      for (const selector of selectors) {
        const locators = this.page!.locator(selector);
        const count = await locators.count();
        for (let index = 0; index < count; index += 1) {
          const locator = locators.nth(index);
          try {
            if (!(await locator.isVisible())) {
              continue;
            }
            const box = await locator.boundingBox();
            if (!box) {
              continue;
            }
            const bottom = Math.round(box.y + box.height);
            const x = Math.round(box.x);
            if (!best || bottom > best.bottom + 4 || (Math.abs(bottom - best.bottom) <= 4 && x > best.x)) {
              best = { locator, bottom, x };
            }
          } catch (error) {
            if (this.isClosedTargetError(error)) {
              return undefined;
            }
          }
        }
      }
      if (best) {
        return best.locator;
      }
      await this.page!.waitForTimeout(250).catch(() => undefined);
    }
    return undefined;
  }

  private async findBottomMostEnabled(selectors: string[], timeoutMs: number): Promise<Locator | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let best: { locator: Locator; bottom: number; x: number } | undefined;
      for (const selector of selectors) {
        const locators = this.page!.locator(selector);
        const count = await locators.count();
        for (let index = 0; index < count; index += 1) {
          const locator = locators.nth(index);
          try {
            if (!(await locator.isVisible()) || !(await locator.isEnabled())) {
              continue;
            }
            const box = await locator.boundingBox();
            if (!box) {
              continue;
            }
            const bottom = Math.round(box.y + box.height);
            const x = Math.round(box.x);
            if (!best || bottom > best.bottom + 4 || (Math.abs(bottom - best.bottom) <= 4 && x > best.x)) {
              best = { locator, bottom, x };
            }
          } catch (error) {
            if (this.isClosedTargetError(error)) {
              return undefined;
            }
          }
        }
      }
      if (best) {
        return best.locator;
      }
      await this.page!.waitForTimeout(200).catch(() => undefined);
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
        await composer.focus();
        await this.page!.keyboard.insertText(fullPrompt);
      },
      async () => {
        await composer.fill(fullPrompt);
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

  private async readComposerText(composer: Locator): Promise<string | undefined> {
    try {
      return await composer.evaluate((node) => {
        if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
          return node.value || '';
        }
        return node.textContent || '';
      });
    } catch {
      return undefined;
    }
  }

  private async composerContainsPrompt(composer: Locator, fullPrompt: string): Promise<boolean | undefined> {
    const expected = fullPrompt.trim();
    if (!expected) {
      return true;
    }

    const actualRaw = await this.readComposerText(composer);
    if (actualRaw === undefined) {
      return undefined;
    }

    const actual = actualRaw.replace(/\s+/g, ' ').trim();
    const probe = expected.slice(0, Math.min(96, expected.length)).replace(/\s+/g, ' ').trim();

    return actual.length >= Math.min(24, expected.length) && actual.includes(probe);
  }

  private async waitForPromptSubmission(composer: Locator, fullPrompt: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.isGenerating()) {
        return true;
      }

      if (this.id === 'deepseek' && (await this.hasDeepSeekRequestStarted(composer))) {
        return true;
      }

      const containsPrompt = await this.composerContainsPrompt(composer, fullPrompt);
      if (containsPrompt === false) {
        return true;
      }

      await this.page!.waitForTimeout(180).catch(() => undefined);
    }

    return false;
  }

  private async hasDeepSeekRequestStarted(composer: Locator): Promise<boolean> {
    const composerBusy = await composer
      .evaluate((node) => {
        const element = node as HTMLElement;
        const input = element as HTMLInputElement | HTMLTextAreaElement;
        return Boolean(
          input.disabled ||
            element.getAttribute('aria-disabled') === 'true' ||
            element.getAttribute('data-disabled') === 'true' ||
            element.closest('[aria-busy="true"], [data-loading="true"], [class*="loading"], [class*="generating"]'),
        );
      })
      .catch(() => false);
    if (composerBusy) {
      return true;
    }

    const visibleStop = await this.page!
      .evaluate(() => {
        const isVisible = (element: HTMLElement): boolean => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };

        return Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]')).some((button) => {
          if (!isVisible(button)) {
            return false;
          }
          const label = [
            button.getAttribute('aria-label'),
            button.getAttribute('title'),
            button.getAttribute('data-testid'),
            button.className,
            button.textContent,
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          return /stop|停止|generating/.test(label);
        });
      })
      .catch(() => false);
    if (visibleStop) {
      return true;
    }

    const currentAssistant = (await this.readAssistantTextFromDomSnapshot()).trim();
    return Boolean(currentAssistant && currentAssistant !== this.lastAssistantBeforeSend.trim());
  }

  private async clickActiveComposerSubmit(composer: Locator): Promise<boolean> {
    const selectors = this.getSelectors('submit');
    const composerHandle = await composer.elementHandle().catch(() => null);
    if (!composerHandle) {
      return false;
    }

    return this.page!.evaluate(({ composerNode, providerId, submitSelectors }) => {
      const composerElement = composerNode as HTMLElement;
      const active = document.activeElement as HTMLElement | null;
      const roots = [
        composerElement.closest('form'),
        composerElement.closest('[data-testid*="composer"]'),
        composerElement.closest('[class*="composer"]'),
        composerElement.parentElement,
        active?.closest('form'),
        active?.closest('[data-testid*="composer"]'),
        active?.closest('[class*="composer"]'),
        document,
      ].filter((root): root is Document | Element => Boolean(root));

      const isVisible = (element: HTMLElement): boolean => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };

      const isSendButton = (button: HTMLButtonElement): boolean => {
        const label = [
          button.getAttribute('aria-label'),
          button.getAttribute('data-testid'),
          button.getAttribute('title'),
          button.textContent,
          button.type,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return !/stop|voice|dictate|attach|upload|model/.test(label) && /send|submit|发送/.test(label);
      };

      const isDeepSeekModeButton = (button: HTMLButtonElement): boolean => {
        const label = [
          button.getAttribute('aria-label'),
          button.getAttribute('data-testid'),
          button.getAttribute('title'),
          button.textContent,
          button.className,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return /deepthink|think|search|联网|深度|推理|voice|dictate|attach|upload|model|menu|close|clear|stop|停止/.test(label);
      };

      for (const root of roots) {
        const candidates = [
          ...submitSelectors.flatMap((selector) => {
            try {
              return Array.from(root.querySelectorAll<HTMLButtonElement>(selector));
            } catch {
              return [];
            }
          }),
          ...Array.from(root.querySelectorAll<HTMLButtonElement>('button')),
        ];

        const button = candidates
          .reverse()
          .find((candidate) => !candidate.disabled && isVisible(candidate) && isSendButton(candidate));
        if (button) {
          button.click();
          return true;
        }

        if (providerId === 'deepseek' && root !== document) {
          const iconButtons = candidates
            .filter((candidate) => !candidate.disabled && isVisible(candidate) && !isDeepSeekModeButton(candidate))
            .map((candidate) => ({ candidate, rect: candidate.getBoundingClientRect() }))
            .filter(({ rect }) => rect.width > 0 && rect.height > 0)
            .sort((left, right) => right.rect.bottom - left.rect.bottom || right.rect.right - left.rect.right);
          const iconButton = iconButtons[0]?.candidate;
          if (iconButton) {
            iconButton.click();
            return true;
          }
        }
      }

      return false;
    }, { composerNode: composerHandle, providerId: this.id, submitSelectors: selectors }).catch(() => false);
  }

  private async submitActiveComposerForm(): Promise<void> {
    await this.page!.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      const form = active?.closest('form');
      if (!form) {
        return;
      }

      const submitter = Array.from(form.querySelectorAll<HTMLButtonElement>('button'))
        .reverse()
        .find((button) => {
          const label = `${button.getAttribute('aria-label') || ''} ${button.getAttribute('data-testid') || ''}`.toLowerCase();
          return !button.disabled && (button.type === 'submit' || /send|submit/.test(label));
        });

      if (submitter) {
        submitter.click();
        return;
      }

      form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    });
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
            const translatedLabel = (await option.locator('[translate="no"]').first().innerText().catch(() => '')).trim();
            const textRaw = translatedLabel || dataValue || (await option.innerText()).trim();
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

          const collapseBlankLines = (value: string): string =>
            value
              .replace(/[ \t]+\n/g, '\n')
              .replace(/\n[ \t]+/g, '\n')
              .replace(/\n{3,}/g, '\n\n')
              .trim();

          const inlineMarkdown = (nodeToRender: Node): string => {
            if (nodeToRender.nodeType === Node.TEXT_NODE) {
              return nodeToRender.textContent || '';
            }

            if (!(nodeToRender instanceof HTMLElement)) {
              return '';
            }

            const tag = nodeToRender.tagName.toLowerCase();
            const inner = Array.from(nodeToRender.childNodes).map(inlineMarkdown).join('');

            if (tag === 'br') {
              return '\n';
            }
            if (tag === 'strong' || tag === 'b') {
              return inner.trim() ? `**${inner.trim()}**` : '';
            }
            if (tag === 'em' || tag === 'i') {
              return inner.trim() ? `*${inner.trim()}*` : '';
            }
            if (tag === 'code' && !nodeToRender.closest('pre')) {
              return inner.trim() ? `\`${inner.trim()}\`` : '';
            }
            return inner;
          };

          const blockMarkdown = (nodeToRender: Node, orderedDepth = 0): string => {
            if (nodeToRender.nodeType === Node.TEXT_NODE) {
              return nodeToRender.textContent || '';
            }

            if (!(nodeToRender instanceof HTMLElement)) {
              return '';
            }

            const tag = nodeToRender.tagName.toLowerCase();

            if (/^h[1-6]$/.test(tag)) {
              const level = Number(tag.slice(1));
              return `\n\n${'#'.repeat(level)} ${inlineMarkdown(nodeToRender).trim()}\n\n`;
            }

            if (tag === 'p') {
              return `\n\n${inlineMarkdown(nodeToRender).trim()}\n\n`;
            }

            if (tag === 'blockquote') {
              const text = collapseBlankLines(Array.from(nodeToRender.childNodes).map((child) => blockMarkdown(child, orderedDepth)).join(''));
              return text ? `\n\n${text.split(/\r?\n/).map((line) => `> ${line}`).join('\n')}\n\n` : '';
            }

            if (tag === 'pre') {
              const codeNode = nodeToRender.querySelector('code');
              const lang =
                codeNode
                  ? Array.from(codeNode.classList)
                      .find((className) => className.startsWith('language-'))
                      ?.replace('language-', '') || ''
                  : '';
              const code = (codeNode?.textContent || nodeToRender.textContent || '')
                .split(/\r?\n/)
                .filter((line) => !/^\s*(copy|python|javascript|typescript|json)\s*$/i.test(line.trim()))
                .join('\n')
                .trim();
              return code ? `\n\n\`\`\`${lang}\n${code}\n\`\`\`\n\n` : '';
            }

            if (tag === 'ul' || tag === 'ol') {
              const items = Array.from(nodeToRender.children)
                .filter((child): child is HTMLElement => child instanceof HTMLElement && child.tagName.toLowerCase() === 'li')
                .map((li, index) => {
                  const marker = tag === 'ol' ? `${index + 1}.` : '-';
                  const text = collapseBlankLines(Array.from(li.childNodes).map((child) => blockMarkdown(child, orderedDepth + 1)).join(''))
                    .split(/\r?\n/)
                    .map((line, lineIndex) => (lineIndex === 0 ? `${marker} ${line}` : `  ${line}`))
                    .join('\n');
                  return text;
                })
                .filter(Boolean);
              return items.length ? `\n\n${items.join('\n')}\n\n` : '';
            }

            if (tag === 'table') {
              const rows = Array.from(nodeToRender.querySelectorAll('tr'))
                .map((row) =>
                  Array.from(row.querySelectorAll('th,td'))
                    .map((cell) => inlineMarkdown(cell).replace(/\s+/g, ' ').trim())
                    .join(' | '),
                )
                .filter(Boolean);
              return rows.length ? `\n\n${rows.join('\n')}\n\n` : '';
            }

            if (tag === 'code') {
              return inlineMarkdown(nodeToRender);
            }

            return Array.from(nodeToRender.childNodes).map((child) => blockMarkdown(child, orderedDepth)).join('');
          };

          return collapseBlankLines(blockMarkdown(clone) || clone.innerText || '');
        };

        const nodes = Array.from(document.querySelectorAll<HTMLElement>(selector));
        const banned = /(new chat|more models|settings|sync|login|send|free ai chatbot|agent powered by|powered by glm|chat with z.ai)/i;
        const hasAgentJsonMarkers = (value: string): boolean => {
          const normalized = value.replace(/\\"/g, '"');
          return /"actions"\s*:|"summary"\s*:|```json/i.test(normalized);
        };
        const candidates = nodes
          .map((node) => {
            const rect = node.getBoundingClientRect();
            const value = stripNoise(node);
            // Ignore if it matches banned text exactly or is a very short fragment of it
            if (banned.test(value.toLowerCase())) return { node, value: '', top: 0, bottom: 0, priority: -1 };
            
            const priority = hasAgentJsonMarkers(value) ? 10 : 0;
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

      const regexRadixValues = [...html.matchAll(/role=["']menuitemradio["'][\s\S]*?<span[^>]*translate=["']no["'][^>]*>([^<]+)<\/span>/gi)]
        .map((match) => (match[1] || '').trim())
        .filter(Boolean);
      if (regexRadixValues.length > 0) {
        return [...new Set(regexRadixValues.map((value) => this.normalizeModelLabel(value)).filter(Boolean))].slice(0, 48);
      }

      const values = await this.page!.evaluate(() => {
        const fromModelItems = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label="model-item"][data-value]'))
          .map((node) => node.getAttribute('data-value') || '')
          .map((value) => value.trim())
          .filter(Boolean);

        if (fromModelItems.length > 0) {
          return fromModelItems;
        }

        const fromRadixModels = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemradio"] [translate="no"]'))
          .map((node) => (node.textContent || '').trim())
          .filter(Boolean);
        if (fromRadixModels.length > 0) {
          return fromRadixModels;
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
    if (this.id === 'kimi') {
      const match = url.match(/\/chat\/([A-Za-z0-9-]{8,})/);
      return match?.[1];
    }
    if (this.id === 'deepseek') {
      const match = url.match(/\/(?:a\/)?chat\/(?:s\/)?([A-Za-z0-9-]{8,})/);
      return match?.[1];
    }
    const match = url.match(/\/c\/([A-Za-z0-9-]{8,})/);
    return match?.[1];
  }

  private buildConversationUrl(conversationId: string): string | undefined {
    if (!conversationId) {
      return undefined;
    }
    if (this.id === 'kimi') {
      return `https://www.kimi.com/chat/${conversationId}`;
    }
    if (this.id === 'deepseek') {
      return `https://chat.deepseek.com/a/chat/s/${conversationId}`;
    }
    const base = this.selectorMap.homeUrl.replace(/\/+$/, '');
    return `${base}/c/${conversationId}`;
  }

  private sanitizeAssistantText(raw: string): string {
    const protocolJson = sanitizeResponse(raw, { preferJson: true });
    const text = /"actions"\s*:/.test(protocolJson) ? protocolJson : sanitizeResponse(raw);

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
    if (stopButton) {
      return true;
    }
    if (this.id === 'deepseek' || this.id === 'kimi') {
      return this.hasWebGeneratingSignal();
    }
    return false;
  }

  private async waitForGenerationToSettleBeforeSend(): Promise<void> {
    if (this.id !== 'deepseek' && this.id !== 'kimi') {
      return;
    }

    const deadline = Date.now() + 90000;
    let quietTicks = 0;
    while (Date.now() < deadline && !this.stopped) {
      if (await this.isGenerating()) {
        quietTicks = 0;
        await this.page!.waitForTimeout(750).catch(() => undefined);
        continue;
      }

      quietTicks += 1;
      if (quietTicks >= 3) {
        return;
      }
      await this.page!.waitForTimeout(500).catch(() => undefined);
    }
  }

  private async hasWebGeneratingSignal(): Promise<boolean> {
    return this.page!
      .evaluate(() => {
        const isVisible = (element: HTMLElement): boolean => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };

        const visibleButtons = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'))
          .filter(isVisible)
          .map((button) =>
            [
              button.getAttribute('aria-label'),
              button.getAttribute('title'),
              button.getAttribute('data-testid'),
              button.className,
              button.textContent,
            ]
              .filter(Boolean)
              .join(' ')
              .toLowerCase(),
          );

        if (visibleButtons.some((label) => /stop|generating|responding|cancel|停止/.test(label))) {
          return true;
        }

        const busyElements = Array.from(
          document.querySelectorAll<HTMLElement>(
            '[aria-busy="true"], [data-loading="true"], [data-state*="loading"], [class*="loading"], [class*="generating"], [class*="typing"]',
          ),
        );
        return busyElements.some(isVisible);
      })
      .catch(() => false);
  }
}
