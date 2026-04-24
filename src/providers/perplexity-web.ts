import * as vscode from 'vscode';
import type { ChatModel } from '../shared/types';
import type { ProviderEvent, ProviderPrompt, ProviderReadiness } from './base';
import { PlaywrightWebProvider } from './playwrightBase';

type QueueResolver = (event: ProviderEvent) => void;
interface PendingWaiter {
  resolve: QueueResolver;
  timer?: ReturnType<typeof setTimeout>;
}
interface ScrapedPerplexityModel {
  id: string;
  label: string;
  selected?: boolean;
}
interface ScrapeModelOptionsResult {
  models: ScrapedPerplexityModel[];
  totalOptions: number;
  lockedFiltered: number;
  disabledFiltered: number;
}

export class PerplexityWebAdapter extends PlaywrightWebProvider {
  private static readonly INITIAL_STREAM_EVENT_TIMEOUT_MS = 45000;
  private static readonly INTER_EVENT_TIMEOUT_MS = 90000;
  private static readonly LOG_PREFIX = '[perplexity-models]';
  private static readonly MODEL_OPTION_SELECTOR =
    '[role="menuitemradio"], [role="option"], button[aria-label="model-item"], button[data-value], [cmdk-item][data-value], [data-value][role="menuitem"], [data-value][role="option"]';

  private static readonly FALLBACK_MODELS: ChatModel[] = [
    { id: 'sonar', label: 'Sonar' },
    { id: 'sonar-pro', label: 'Sonar Pro' },
    { id: 'sonar-reasoning', label: 'Sonar Reasoning' },
    { id: 'sonar-deep-research', label: 'Sonar Deep Research' },
    { id: 'gpt-5.1', label: 'GPT-5.1' },
    { id: 'gpt-5', label: 'GPT-5' },
    { id: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { id: 'grok-4', label: 'Grok 4' },
    { id: 'deepseek-r1', label: 'DeepSeek R1' },
  ];
  private static readonly MODEL_PICKER_CANDIDATES = [
    'button[aria-label*="Model"]',
    'button[aria-haspopup="menu"][aria-label*="Thinking"]',
    'button[aria-haspopup="menu"][aria-label*="GPT"]',
    'button[aria-haspopup="menu"][aria-label*="Claude"]',
    'button[aria-haspopup="menu"][aria-label*="Gemini"]',
    'button[aria-haspopup="menu"]:has([translate="no"])',
    'button[aria-haspopup="menu"]:has-text("Best")',
    'button[aria-haspopup="menu"]:has-text("Sonar")',
    '[role="combobox"]',
    'button[aria-haspopup="menu"]',
  ];
  private readonly queue: ProviderEvent[] = [];
  private readonly waiters: PendingWaiter[] = [];
  private modelCache: ChatModel[] = this.getFallbackModels();
  private bindingsInstalled = false;

  constructor(context: vscode.ExtensionContext) {
    super('perplexity', context);
  }

  override listModels(): ChatModel[] {
    return this.ensureAutoModelFirst(this.modelCache);
  }

  override async refreshModels(): Promise<ChatModel[]> {
    await this.ensurePage(false);
    await this.ensureOnOrigin();

    const opened = await this.ensureModelPickerOpen();
    let scrapedModels: ScrapedPerplexityModel[] = [];
    let scrapeStats: ScrapeModelOptionsResult | undefined;
    if (!opened) {
      console.warn(`${PerplexityWebAdapter.LOG_PREFIX} refresh: picker not found/opened; attempting non-visible DOM scrape.`);
      scrapeStats = await this.scrapeModelOptions(false);
      scrapedModels = scrapeStats.models;
    } else {
      scrapeStats = await this.scrapeModelOptions(true);
      scrapedModels = scrapeStats.models;
      await this.page!.keyboard.press('Escape').catch(() => undefined);
    }

    if (scrapedModels.length === 0) {
      scrapedModels = await this.scrapeModelHintsFromTranslateNodes();
    }

    if (scrapedModels.length > 0) {
      this.modelCache = this.toPerplexityModelList(scrapedModels);
      const labels = this.modelCache
        .filter((entry) => entry.id !== 'auto')
        .map((entry) => entry.label)
        .slice(0, 12)
        .join(', ');
      console.log(
        `${PerplexityWebAdapter.LOG_PREFIX} refresh: scraped=${scrapedModels.length} totalSeen=${
          scrapeStats?.totalOptions ?? 'n/a'
        } lockedFiltered=${scrapeStats?.lockedFiltered ?? 0} disabledFiltered=${scrapeStats?.disabledFiltered ?? 0}.${
          labels ? ` Models: ${labels}` : ''
        }`,
      );
    } else {
      console.warn(`${PerplexityWebAdapter.LOG_PREFIX} refresh: no models scraped; keeping cached/fallback models.`);
      if (this.modelCache.length <= 1) {
        this.modelCache = this.getFallbackModels();
      }
    }

    this.modelCache = this.ensureAutoModelFirst(this.modelCache);
    return this.modelCache;
  }

  override async selectModel(modelId: string): Promise<boolean> {
    const normalizedRequest = this.normalizeModelToken(modelId);
    const requestedAuto = !modelId || normalizedRequest === 'auto';

    await this.ensurePage(false);
    await this.ensureOnOrigin();

    const opened = await this.ensureModelPickerOpen();
    if (!opened) {
      if (requestedAuto) {
        console.warn(`${PerplexityWebAdapter.LOG_PREFIX} select: picker unavailable while selecting Auto/Best; keeping current default.`);
        return true;
      }
      console.warn(`${PerplexityWebAdapter.LOG_PREFIX} select failed: picker not found for "${modelId}".`);
      return false;
    }

    const optionsResult = await this.scrapeModelOptions(true);
    const options = optionsResult.models;
    const target = this.pickBestModelOption(options, requestedAuto ? 'best' : modelId);
    if (!target) {
      await this.page!.keyboard.press('Escape').catch(() => undefined);
      if (requestedAuto) {
        console.log(`${PerplexityWebAdapter.LOG_PREFIX} select: Auto requested and no Best option found; keeping default mode.`);
        return true;
      }
      console.warn(
        `${PerplexityWebAdapter.LOG_PREFIX} select failed: "${modelId}" not found in ${options.length} scraped option(s).`,
      );
      return false;
    }

    const clicked = await this.clickModelOption(target);
    if (!clicked) {
      await this.page!.keyboard.press('Escape').catch(() => undefined);
      if (requestedAuto) {
        console.warn(`${PerplexityWebAdapter.LOG_PREFIX} select: failed to click Best option; keeping default mode.`);
        return true;
      }
      console.warn(`${PerplexityWebAdapter.LOG_PREFIX} select failed: unable to click "${target.label}" (${target.id}).`);
      return false;
    }

    await this.page!.waitForTimeout(250);
    const pickerLabel = await this.readCurrentPickerLabel();
    let verified = this.matchesModelToken(pickerLabel, target.id) || this.matchesModelToken(pickerLabel, target.label);

    if (!verified) {
      if (await this.ensureModelPickerOpen()) {
        const selectedInMenu = await this.readSelectedModelFromMenu();
        verified =
          (selectedInMenu && this.matchesModelToken(selectedInMenu.id, target.id)) ||
          (selectedInMenu && this.matchesModelToken(selectedInMenu.label, target.label)) ||
          false;
      }
    }

    await this.page!.keyboard.press('Escape').catch(() => undefined);

    if (!verified) {
      if (requestedAuto) {
        console.warn(`${PerplexityWebAdapter.LOG_PREFIX} select: Best click not fully verified; continuing with current default.`);
        return true;
      }
      console.warn(`${PerplexityWebAdapter.LOG_PREFIX} select did not verify for "${target.label}" (${target.id}).`);
      return false;
    }

    if (!this.modelCache.some((model) => this.matchesModelToken(model.id, target.id))) {
      this.modelCache = this.ensureAutoModelFirst([...this.modelCache, { id: target.id, label: target.label }]);
    }

    console.log(`${PerplexityWebAdapter.LOG_PREFIX} select: verified "${target.label}" (${target.id}).`);
    return true;
  }

  override async checkReady(): Promise<ProviderReadiness> {
    await this.ensurePage(false);
    await this.ensureOnOrigin();

    const sessionState = await this.page!.evaluate(async () => {
      try {
        const response = await fetch('/api/auth/session', { credentials: 'include' });
        if (!response.ok) {
          return { hasUser: false, hasPayload: false };
        }
        const payload = (await response.json()) as { user?: Record<string, unknown> } | null;
        const user = payload?.user;
        const hasUser =
          Boolean(user) &&
          ['id', 'email', 'name', 'image'].some((field) => typeof user?.[field] === 'string' && user[field]!.trim().length > 0);

        const hasPayload = Boolean(payload && typeof payload === 'object' && Object.keys(payload).length > 0);
        return { hasUser, hasPayload };
      } catch {
        return { hasUser: false, hasPayload: false };
      }
    });

    if (sessionState.hasUser) {
      return { ready: true, loginRequired: false };
    }

    const domFallback = await super.checkReady();
    if (domFallback.ready) {
      return { ready: true, loginRequired: false };
    }

    // When session payload exists but user details are omitted, prefer the DOM signal.
    if (sessionState.hasPayload) {
      return domFallback;
    }

    return domFallback;
  }

  override async startNewConversation(): Promise<string | undefined> {
    await this.ensurePage(false);
    await this.page!.goto(this.selectorMap.homeUrl, { waitUntil: 'domcontentloaded' });
    return undefined;
  }

  override async openConversation(conversationId: string): Promise<boolean> {
    if (!conversationId.trim()) {
      return false;
    }

    await this.ensurePage(false);
    const target = `${this.selectorMap.homeUrl.replace(/\/+$/, '')}/search/${conversationId}`;
    await this.page!.goto(target, { waitUntil: 'domcontentloaded' });
    return this.getConversationIdFromUrl(this.page!.url()) === conversationId;
  }

  override async getCurrentConversationId(): Promise<string | undefined> {
    await this.ensurePage(false);
    return this.getConversationIdFromUrl(this.page!.url());
  }

  override async sendPrompt(input: ProviderPrompt): Promise<void> {
    await this.ensurePage(false);
    await this.ensureHookInstalled();
    await this.page!
      .evaluate((enabled) => {
        const scope = globalThis as typeof globalThis & { __webagentPerplexityEnableThinking?: boolean };
        if (typeof enabled === 'boolean') {
          scope.__webagentPerplexityEnableThinking = enabled;
          return;
        }
        delete scope.__webagentPerplexityEnableThinking;
      }, input.enableThinking)
      .catch(() => undefined);
    this.resetQueue();
    await super.sendPrompt(input);
  }

  override async streamEvents(onEvent: (event: ProviderEvent) => void): Promise<void> {
    onEvent({ type: 'status', message: 'Waiting for perplexity response...' });
    let sawEvent = false;
    while (true) {
      const event = await this.nextEvent(
        sawEvent ? PerplexityWebAdapter.INTER_EVENT_TIMEOUT_MS : PerplexityWebAdapter.INITIAL_STREAM_EVENT_TIMEOUT_MS,
      );
      sawEvent = true;
      onEvent(event);
      if (event.type === 'done' || event.type === 'error') {
        return;
      }
    }
  }

  override async stop(): Promise<void> {
    await super.stop();
    if (this.page && !this.page.isClosed()) {
      await this.page
        .evaluate(() => {
          const scope = globalThis as typeof globalThis & { __webagentPerplexityAbort?: AbortController };
          scope.__webagentPerplexityAbort?.abort();
        })
        .catch(() => undefined);
    }
  }

  override async resetConversation(): Promise<void> {
    await this.startNewConversation();
  }

  private async ensureOnOrigin(): Promise<void> {
    const current = this.page?.url() || '';
    const origin = new URL(this.selectorMap.homeUrl).origin;
    if (!current || current === 'about:blank' || !current.startsWith(origin)) {
      await this.page!.goto(this.selectorMap.homeUrl, { waitUntil: 'domcontentloaded' });
    }
  }

  private async ensureModelPickerOpen(): Promise<boolean> {
    if (await this.hasVisibleModelOptions(2)) {
      return true;
    }
    const deadline = Date.now() + 12000;
    let attempts = 0;

    while (Date.now() < deadline) {
      attempts += 1;
      const likelyPickerClicked = await this.clickLikelyModelPickerButton();
      if (likelyPickerClicked) {
        await this.page!.waitForTimeout(320);
        if (await this.hasVisibleModelOptions(2)) {
          console.log(`${PerplexityWebAdapter.LOG_PREFIX} picker: opened via scored picker button after ${attempts} attempt(s).`);
          return true;
        }
        await this.page!.keyboard.press('Escape').catch(() => undefined);
        await this.page!.waitForTimeout(140);
      }

      for (const selector of PerplexityWebAdapter.MODEL_PICKER_CANDIDATES) {
        const trigger = this.page!.locator(selector).first();
        try {
          if ((await trigger.count()) === 0 || !(await trigger.isVisible())) {
            continue;
          }
          if (await trigger.isDisabled()) {
            continue;
          }
          await trigger.click().catch(() => undefined);
          await this.page!.waitForTimeout(300);
          if (await this.hasVisibleModelOptions(2)) {
            console.log(
              `${PerplexityWebAdapter.LOG_PREFIX} picker: opened via selector "${selector}" after ${attempts} attempt(s).`,
            );
            return true;
          }
          await this.page!.keyboard.press('Escape').catch(() => undefined);
          await this.page!.waitForTimeout(150);
        } catch {
          // Ignore and continue with next candidate.
        }
      }
      await this.page!.waitForTimeout(350).catch(() => undefined);
    }

    const visible = await this.hasVisibleModelOptions(2);
    if (!visible) {
      console.warn(`${PerplexityWebAdapter.LOG_PREFIX} picker: failed to open after ${attempts} attempt(s).`);
    }
    return visible;
  }

  private async hasVisibleModelOptions(minLikelyCount = 1): Promise<boolean> {
    return this.page!
      .evaluate(({ optionSelector, minCount }) => {
        const normalize = (value: string): string =>
          value
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
              .join(' ')
              .replace(/\s+/g, ' ')
              .trim();
        const normalizeKey = (value: string): string =>
          normalize(value)
            .toLowerCase()
            .replace(/[\s_-]+/g, ' ')
            .replace(/[^a-z0-9.]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        const pickOptionRoot = (node: HTMLElement): HTMLElement =>
          node.closest<HTMLElement>(
            '[data-radix-scroll-area-viewport], [role="menu"], [data-radix-popper-content-wrapper], [data-radix-dropdown-menu-content], [role="group"]',
          ) ??
          node.parentElement ??
          node;
        const isLikelyModelLabel = (value: string): boolean => {
          const lowered = normalizeKey(value);
          if (!lowered || lowered.length < 2 || lowered.length > 220) {
            return false;
          }
          if (/new chat|settings|help|logout|log out|switch to|upgrade|attach|thinking|computer|tool/i.test(lowered)) {
            return false;
          }
          if (lowered === 'best' || lowered === 'sonar') {
            return true;
          }
          if (/\d/.test(lowered)) {
            return true;
          }
          return /(gpt|gemini|claude|kimi|nemotron|llama|qwen|deepseek|mistral|opus|sonnet|haiku|grok|turbo|reasoning|r\d+|o\d+)/i.test(
            lowered,
          );
        };
        const isVisible = (node: HTMLElement): boolean => {
          const style = window.getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
            return false;
          }
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const rootStats = new Map<HTMLElement, { likelyCount: number; hasBestOrSonar: boolean; hasModelFamily: boolean }>();
        for (const node of Array.from(document.querySelectorAll<HTMLElement>(optionSelector))) {
          if (!isVisible(node)) {
            continue;
          }
          const role = (node.getAttribute('role') || '').toLowerCase();
          if (role === 'menuitemcheckbox' || node.querySelector('[role="switch"]')) {
            continue;
          }
          const label = normalize(
            node.querySelector<HTMLElement>('[translate="no"]')?.textContent ||
              node.getAttribute('aria-label') ||
              node.getAttribute('data-value') ||
              node.textContent ||
              '',
          );
          if (!isLikelyModelLabel(label)) {
            continue;
          }
          const root = pickOptionRoot(node);
          const current = rootStats.get(root) ?? { likelyCount: 0, hasBestOrSonar: false, hasModelFamily: false };
          current.likelyCount += 1;
          if (/\b(best|sonar)\b/i.test(label)) {
            current.hasBestOrSonar = true;
          }
          if (/(gpt|gemini|claude|kimi|nemotron|llama|qwen|deepseek|mistral|opus|sonnet|haiku|grok|turbo|r\d+|o\d+)/i.test(label)) {
            current.hasModelFamily = true;
          }
          rootStats.set(root, current);
        }

        let bestScore = -1;
        let best: { likelyCount: number; hasBestOrSonar: boolean; hasModelFamily: boolean } | undefined;
        for (const stats of rootStats.values()) {
          const score = stats.likelyCount + (stats.hasBestOrSonar ? 4 : 0) + (stats.hasModelFamily ? 2 : 0);
          if (score > bestScore) {
            bestScore = score;
            best = stats;
          }
        }

        return Boolean(
          best &&
            best.likelyCount >= minCount &&
            (best.hasBestOrSonar || best.hasModelFamily || best.likelyCount >= Math.max(minCount, 3)),
        );
      }, { optionSelector: PerplexityWebAdapter.MODEL_OPTION_SELECTOR, minCount: minLikelyCount })
      .catch(() => false);
  }

  private async scrapeModelOptions(visibleOnly: boolean): Promise<ScrapeModelOptionsResult> {
    return this.page!
      .evaluate(
        ({ optionSelector, visibleOnlyFlag }) => {
          const normalize = (value: string): string =>
            value
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter(Boolean)
              .join(' ')
              .replace(/\s+/g, ' ')
              .replace(/\b(currently selected|selected|recommended)\b/gi, '')
              .trim();
          const normalizeKey = (value: string): string =>
          normalize(value)
            .toLowerCase()
            .replace(/[\s_-]+/g, ' ')
            .replace(/[^a-z0-9.]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          const pickOptionRoot = (node: HTMLElement): HTMLElement =>
            node.closest<HTMLElement>(
              '[data-radix-scroll-area-viewport], [role="menu"], [data-radix-popper-content-wrapper], [data-radix-dropdown-menu-content], [role="group"]',
            ) ??
            node.parentElement ??
            node;
          const isVisible = (node: HTMLElement): boolean => {
            const style = window.getComputedStyle(node);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
              return false;
            }
            const rect = node.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          };
          const isLikelyModelLabel = (value: string): boolean => {
            const lowered = normalizeKey(value);
            if (!lowered || lowered.length < 2 || lowered.length > 220) {
              return false;
            }
            if (/new chat|settings|help|logout|log out|switch to|upgrade|attach|thinking|computer|tool/i.test(lowered)) {
              return false;
            }
            if (lowered === 'best' || lowered === 'sonar') {
              return true;
            }
            if (/\d/.test(lowered)) {
              return true;
            }
            return /(gpt|gemini|claude|kimi|nemotron|llama|qwen|deepseek|mistral|opus|sonnet|haiku|grok|turbo|reasoning|r\d+|o\d+)/i.test(
              lowered,
            );
          };

          const seen = new Set<string>();
          const models: ScrapedPerplexityModel[] = [];
          let lockedFiltered = 0;
          let disabledFiltered = 0;
          const allOptions = Array.from(document.querySelectorAll<HTMLElement>(optionSelector));
          const rootStats = new Map<HTMLElement, { likelyCount: number; hasBestOrSonar: boolean; hasModelFamily: boolean }>();

          for (const option of allOptions) {
            if (visibleOnlyFlag && !isVisible(option)) {
              continue;
            }
            const role = (option.getAttribute('role') || '').toLowerCase();
            if (role === 'menuitemcheckbox' || option.querySelector('[role="switch"]')) {
              continue;
            }
            const rawDataValue = option.getAttribute('data-value') || option.dataset.value || option.getAttribute('value') || '';
            const rawAriaLabel = option.getAttribute('aria-label') || '';
            const translatedText = (option.querySelector<HTMLElement>('[translate="no"]')?.textContent || '').trim();
            const fallbackText = (option.textContent || '').trim();
            const label = normalize(translatedText || rawAriaLabel || rawDataValue || fallbackText);
            if (!isLikelyModelLabel(label)) {
              continue;
            }
            const root = pickOptionRoot(option);
            const current = rootStats.get(root) ?? { likelyCount: 0, hasBestOrSonar: false, hasModelFamily: false };
            current.likelyCount += 1;
            if (/\b(best|sonar)\b/i.test(label)) {
              current.hasBestOrSonar = true;
            }
            if (/(gpt|gemini|claude|kimi|nemotron|llama|qwen|deepseek|mistral|opus|sonnet|haiku|grok|turbo|r\d+|o\d+)/i.test(label)) {
              current.hasModelFamily = true;
            }
            rootStats.set(root, current);
          }

          let bestRoot: HTMLElement | undefined;
          let bestScore = -1;
          for (const [root, stats] of rootStats.entries()) {
            const score = stats.likelyCount + (stats.hasBestOrSonar ? 4 : 0) + (stats.hasModelFamily ? 2 : 0);
            if (score > bestScore) {
              bestScore = score;
              bestRoot = root;
            }
          }

          const scopedOptions = bestRoot ? allOptions.filter((option) => pickOptionRoot(option) === bestRoot) : allOptions;
          const totalOptions = scopedOptions.length;

          for (const option of scopedOptions) {
            if (visibleOnlyFlag && !isVisible(option)) {
              continue;
            }
            const role = (option.getAttribute('role') || '').toLowerCase();
            if (role === 'menuitemcheckbox' || option.querySelector('[role="switch"]')) {
              continue;
            }
            const isDisabled =
              option.getAttribute('aria-disabled') === 'true' ||
              option.hasAttribute('disabled') ||
              option.getAttribute('data-disabled') === 'true';
            if (isDisabled) {
              disabledFiltered += 1;
              continue;
            }
            const hasLockUse = Array.from(option.querySelectorAll<SVGUseElement>('use')).some((node) => {
              const hrefValue = node.getAttribute('href') || node.getAttribute('xlink:href') || '';
              return /lock/i.test(hrefValue);
            });
            const hasLockIcon =
              hasLockUse ||
              Boolean(option.querySelector('[aria-label*="lock" i], [data-testid*="lock" i], [title*="lock" i]'));
            if (hasLockIcon) {
              lockedFiltered += 1;
              continue;
            }

            const rawDataValue =
              option.getAttribute('data-value') ||
              option.dataset.value ||
              option.getAttribute('value') ||
              '';
            const rawAriaLabel = option.getAttribute('aria-label') || '';
            const translatedText = (option.querySelector<HTMLElement>('[translate="no"]')?.textContent || '').trim();
            const fallbackText = (option.textContent || '').trim();

            let label = normalize(translatedText || rawAriaLabel || fallbackText);
            if (label.includes('  ')) {
              label = normalize(label);
            }
            if (/\n/.test(label)) {
              const firstLine = label
                .split(/\r?\n/)
                .map((line) => normalize(line))
                .find((line) => line.length > 0);
              label = firstLine || label;
            }
            if (!isLikelyModelLabel(label)) {
              continue;
            }

            const normalizedLabelKey = normalizeKey(label);
            const idCandidate = normalize(rawDataValue || rawAriaLabel || label);
            let id = idCandidate;
            let finalLabel = label;
            if (normalizedLabelKey === 'best' || normalizeKey(idCandidate) === 'best') {
              id = 'auto';
              finalLabel = 'Auto';
            }
            if (!id) {
              continue;
            }

            const uniqueKey = `${normalizeKey(id)}::${normalizeKey(finalLabel)}`;
            if (seen.has(uniqueKey)) {
              continue;
            }
            seen.add(uniqueKey);

            const selected =
              option.getAttribute('aria-checked') === 'true' ||
              option.getAttribute('data-state') === 'checked' ||
              Boolean(option.querySelector('[data-state="checked"]')) ||
              Boolean(option.closest<HTMLElement>('.bg-subtle'));
            models.push({ id, label: finalLabel, selected });
          }

          return {
            models,
            totalOptions,
            lockedFiltered,
            disabledFiltered,
          };
        },
        {
          optionSelector: PerplexityWebAdapter.MODEL_OPTION_SELECTOR,
          visibleOnlyFlag: visibleOnly,
        },
      )
      .catch(() => ({
        models: [],
        totalOptions: 0,
        lockedFiltered: 0,
        disabledFiltered: 0,
      }));
  }

  private async scrapeModelHintsFromTranslateNodes(): Promise<ScrapedPerplexityModel[]> {
    return this.page!
      .evaluate(() => {
        const normalize = (value: string): string =>
          value
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .join(' ')
            .replace(/\s+/g, ' ')
            .replace(/\b(currently selected|selected|recommended)\b/gi, '')
            .trim();

        const looksLikeModel = (value: string): boolean =>
          /(best|sonar|gpt|gemini|claude|kimi|nemotron|llama|qwen|deepseek|opus|sonnet|haiku|pro|r\d+)/i.test(value);

        const deduped = new Map<string, ScrapedPerplexityModel>();
        const nodes = Array.from(document.querySelectorAll<HTMLElement>('[translate="no"]'));
        for (const node of nodes) {
          const optionRoot = node.closest<HTMLElement>('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"]');
          const hasLockUse = optionRoot
            ? Array.from(optionRoot.querySelectorAll<SVGUseElement>('use')).some((use) => {
                const hrefValue = use.getAttribute('href') || use.getAttribute('xlink:href') || '';
                return /lock/i.test(hrefValue);
              })
            : false;
          const isDisabled =
            optionRoot?.getAttribute('aria-disabled') === 'true' ||
            optionRoot?.hasAttribute('disabled') ||
            optionRoot?.getAttribute('data-disabled') === 'true';
          if (hasLockUse || isDisabled) {
            continue;
          }
          const label = normalize(node.textContent || '');
          if (!label || label.length > 80 || !looksLikeModel(label)) {
            continue;
          }
          const id = /best/i.test(label) ? 'auto' : label;
          const key = `${id.toLowerCase()}::${label.toLowerCase()}`;
          if (!deduped.has(key)) {
            deduped.set(key, { id, label });
          }
        }

        return Array.from(deduped.values());
      })
      .catch(() => []);
  }

  private getFallbackModels(): ChatModel[] {
    return this.ensureAutoModelFirst(PerplexityWebAdapter.FALLBACK_MODELS);
  }

  private toPerplexityModelList(models: ScrapedPerplexityModel[]): ChatModel[] {
    const deduped = new Map<string, ChatModel>();
    for (const item of models) {
      const label = this.cleanModelLabel(item.label);
      let id = this.cleanModelLabel(item.id);
      if (!label) {
        continue;
      }
      if (!this.isLikelyPerplexityModelToken(label) && !this.isLikelyPerplexityModelToken(id)) {
        continue;
      }
      if (this.normalizeModelToken(label) === 'best' || this.normalizeModelToken(id) === 'best') {
        id = 'auto';
      }
      if (!id) {
        continue;
      }
      if (this.normalizeModelToken(id) === 'auto') {
        continue;
      }
      const key = this.normalizeModelToken(id);
      if (!deduped.has(key)) {
        deduped.set(key, { id, label });
      }
    }
    return [{ id: 'auto', label: 'Auto' }, ...deduped.values()];
  }

  private pickBestModelOption(options: ScrapedPerplexityModel[], modelId: string): ScrapedPerplexityModel | undefined {
    const target = this.normalizeModelToken(modelId);
    if (!target) {
      return undefined;
    }

    const targetAliases = new Set<string>([target]);
    if (target === 'auto' || target === 'best') {
      targetAliases.add('auto');
      targetAliases.add('best');
      targetAliases.add('sonar');
    }

    let best: ScrapedPerplexityModel | undefined;
    let bestScore = 0;
    for (const option of options) {
      const idKey = this.normalizeModelToken(option.id);
      const labelKey = this.normalizeModelToken(option.label);
      let score = 0;

      if (targetAliases.has(idKey)) {
        score = 130;
      } else if (targetAliases.has(labelKey)) {
        score = 120;
      } else if (idKey.includes(target) || target.includes(idKey)) {
        score = 90;
      } else if (labelKey.includes(target) || target.includes(labelKey)) {
        score = 85;
      } else {
        const targetWords = target.split(' ').filter((word) => word.length > 1);
        const idWordHits = targetWords.filter((word) => idKey.includes(word)).length;
        const labelWordHits = targetWords.filter((word) => labelKey.includes(word)).length;
        const wordHits = Math.max(idWordHits, labelWordHits);
        if (targetWords.length > 0 && wordHits >= Math.ceil(targetWords.length * 0.75)) {
          score = 70 + wordHits;
        }
      }

      if (score > bestScore) {
        best = option;
        bestScore = score;
      }
    }

    return best;
  }

  private async clickModelOption(target: ScrapedPerplexityModel): Promise<boolean> {
    const markerAttribute = 'data-webagent-model-click-target';
    const marked = await this.page!
      .evaluate(
        ({ optionSelector, targetId, targetLabel, marker }) => {
          const normalize = (value: string): string =>
            value
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter(Boolean)
              .join(' ')
              .replace(/\s+/g, ' ')
              .replace(/\b(currently selected|selected|recommended)\b/gi, '')
              .trim();
          const normalizeKey = (value: string): string =>
            normalize(value)
              .toLowerCase()
              .replace(/[\s_-]+/g, ' ')
              .replace(/[^a-z0-9.]+/g, ' ')
              .replace(/\s+/g, ' ')
              .trim();
          const isVisible = (node: HTMLElement): boolean => {
            const style = window.getComputedStyle(node);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
              return false;
            }
            const rect = node.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          };
          const hasLockIcon = (node: HTMLElement): boolean =>
            Array.from(node.querySelectorAll<SVGUseElement>('use')).some((use) => {
              const hrefValue = use.getAttribute('href') || use.getAttribute('xlink:href') || '';
              return /lock/i.test(hrefValue);
            }) || Boolean(node.querySelector('[aria-label*="lock" i], [data-testid*="lock" i], [title*="lock" i]'));
          const isDisabled = (node: HTMLElement): boolean =>
            node.getAttribute('aria-disabled') === 'true' ||
            node.hasAttribute('disabled') ||
            node.getAttribute('data-disabled') === 'true';
          const labelFor = (node: HTMLElement): string =>
            normalize(
              node.querySelector<HTMLElement>('[translate="no"]')?.textContent ||
                node.getAttribute('aria-label') ||
                node.getAttribute('data-value') ||
                node.textContent ||
                '',
            );
          const scoreCandidate = (idKey: string, labelKey: string, targetKey: string, targetLabelKey: string): number => {
            const aliases = new Set<string>([targetKey, targetLabelKey].filter(Boolean));
            if (targetKey === 'auto' || targetKey === 'best') {
              aliases.add('auto');
              aliases.add('best');
              aliases.add('sonar');
            }
            if (aliases.has(idKey)) {
              return 140;
            }
            if (aliases.has(labelKey)) {
              return 130;
            }
            if (idKey && targetKey && (idKey.includes(targetKey) || targetKey.includes(idKey))) {
              return 95;
            }
            if (labelKey && targetLabelKey && (labelKey.includes(targetLabelKey) || targetLabelKey.includes(labelKey))) {
              return 90;
            }
            const words = (targetLabelKey || targetKey).split(' ').filter((word) => word.length > 1);
            if (words.length === 0) {
              return 0;
            }
            const idHits = words.filter((word) => idKey.includes(word)).length;
            const labelHits = words.filter((word) => labelKey.includes(word)).length;
            const hits = Math.max(idHits, labelHits);
            return hits >= Math.ceil(words.length * 0.75) ? 70 + hits : 0;
          };

          document.querySelectorAll<HTMLElement>(`[${marker}]`).forEach((node) => node.removeAttribute(marker));

          const targetIdKey = normalizeKey(targetId);
          const targetLabelKey = normalizeKey(targetLabel);
          const options = Array.from(document.querySelectorAll<HTMLElement>(optionSelector));
          let bestNode: HTMLElement | undefined;
          let bestScore = 0;

          for (const option of options) {
            const role = (option.getAttribute('role') || '').toLowerCase();
            if (role === 'menuitemcheckbox' || option.querySelector('[role="switch"]')) {
              continue;
            }
            if (!isVisible(option) || isDisabled(option) || hasLockIcon(option)) {
              continue;
            }
            const dataValue = normalize(option.getAttribute('data-value') || option.dataset.value || option.getAttribute('value') || '');
            const ariaLabel = normalize(option.getAttribute('aria-label') || '');
            const text = labelFor(option);
            const idKey = normalizeKey(dataValue || ariaLabel || text);
            const labelKey = normalizeKey(text || ariaLabel || dataValue);
            const score = scoreCandidate(idKey, labelKey, targetIdKey, targetLabelKey);
            if (score > bestScore) {
              bestNode = option;
              bestScore = score;
            }
          }

          if (!bestNode || bestScore <= 0) {
            return false;
          }

          bestNode.setAttribute(marker, 'true');
          bestNode.scrollIntoView({ block: 'center', inline: 'nearest' });
          return true;
        },
        {
          optionSelector: PerplexityWebAdapter.MODEL_OPTION_SELECTOR,
          targetId: target.id,
          targetLabel: target.label,
          marker: markerAttribute,
        },
      )
      .catch(() => false);

    if (!marked) {
      return false;
    }

    const locator = this.page!.locator(`[${markerAttribute}="true"]`).first();
    try {
      await locator.click({ timeout: 5000 });
      return true;
    } catch {
      return this.page!
        .evaluate((marker) => {
          const node = document.querySelector<HTMLElement>(`[${marker}="true"]`);
          if (!node) {
            return false;
          }
          node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
          node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          node.click();
          return true;
        }, markerAttribute)
        .catch(() => false);
    } finally {
      await this.page!
        .evaluate((marker) => {
          document.querySelectorAll<HTMLElement>(`[${marker}]`).forEach((node) => node.removeAttribute(marker));
        }, markerAttribute)
        .catch(() => undefined);
    }
  }

  private async readSelectedModelFromMenu(): Promise<ScrapedPerplexityModel | undefined> {
    return this.page!
      .evaluate((optionSelector) => {
        const normalize = (value: string): string =>
          value
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .join(' ')
            .replace(/\s+/g, ' ')
            .replace(/\b(currently selected|selected|recommended)\b/gi, '')
            .trim();
        const normalizeKey = (value: string): string =>
          normalize(value)
            .toLowerCase()
            .replace(/[\s_-]+/g, ' ')
            .replace(/[^a-z0-9.]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        const pickOptionRoot = (node: HTMLElement): HTMLElement =>
          node.closest<HTMLElement>(
            '[data-radix-scroll-area-viewport], [role="menu"], [data-radix-popper-content-wrapper], [data-radix-dropdown-menu-content], [role="group"]',
          ) ??
          node.parentElement ??
          node;
        const isLikelyModelLabel = (value: string): boolean => {
          const lowered = normalizeKey(value);
          if (!lowered || lowered.length < 2 || lowered.length > 220) {
            return false;
          }
          if (/new chat|settings|help|logout|log out|switch to|upgrade|attach|thinking|computer|tool/i.test(lowered)) {
            return false;
          }
          if (lowered === 'best' || lowered === 'sonar') {
            return true;
          }
          if (/\d/.test(lowered)) {
            return true;
          }
          return /(gpt|gemini|claude|kimi|nemotron|llama|qwen|deepseek|mistral|opus|sonnet|haiku|grok|turbo|reasoning|r\d+|o\d+)/i.test(
            lowered,
          );
        };
        const allOptions = Array.from(document.querySelectorAll<HTMLElement>(optionSelector));
        const rootStats = new Map<HTMLElement, { likelyCount: number; hasBestOrSonar: boolean; hasModelFamily: boolean }>();

        for (const option of allOptions) {
          const role = (option.getAttribute('role') || '').toLowerCase();
          if (role === 'menuitemcheckbox' || option.querySelector('[role="switch"]')) {
            continue;
          }
          const label = normalize(
            option.querySelector<HTMLElement>('[translate="no"]')?.textContent ||
              option.getAttribute('aria-label') ||
              option.getAttribute('data-value') ||
              option.textContent ||
              '',
          );
          if (!isLikelyModelLabel(label)) {
            continue;
          }
          const root = pickOptionRoot(option);
          const current = rootStats.get(root) ?? { likelyCount: 0, hasBestOrSonar: false, hasModelFamily: false };
          current.likelyCount += 1;
          if (/\b(best|sonar)\b/i.test(label)) {
            current.hasBestOrSonar = true;
          }
          if (/(gpt|gemini|claude|kimi|nemotron|llama|qwen|deepseek|mistral|opus|sonnet|haiku|grok|turbo|r\d+|o\d+)/i.test(label)) {
            current.hasModelFamily = true;
          }
          rootStats.set(root, current);
        }

        let bestRoot: HTMLElement | undefined;
        let bestRootScore = -1;
        for (const [root, stats] of rootStats.entries()) {
          const score = stats.likelyCount + (stats.hasBestOrSonar ? 4 : 0) + (stats.hasModelFamily ? 2 : 0);
          if (score > bestRootScore) {
            bestRootScore = score;
            bestRoot = root;
          }
        }

        const scopedOptions = bestRoot ? allOptions.filter((option) => pickOptionRoot(option) === bestRoot) : allOptions;

        for (const option of scopedOptions) {
          const role = (option.getAttribute('role') || '').toLowerCase();
          if (role === 'menuitemcheckbox' || option.querySelector('[role="switch"]')) {
            continue;
          }
          const selected =
            option.getAttribute('aria-checked') === 'true' ||
            option.getAttribute('data-state') === 'checked' ||
            Boolean(option.querySelector('[data-state="checked"]')) ||
            Boolean(option.closest<HTMLElement>('.bg-subtle'));
          if (!selected) {
            continue;
          }
          const dataValue =
            normalize(option.getAttribute('data-value') || option.dataset.value || option.getAttribute('value') || '');
          const ariaLabel = normalize(option.getAttribute('aria-label') || '');
          const translatedText = normalize(option.querySelector<HTMLElement>('[translate="no"]')?.textContent || '');
          const label = normalize(translatedText || ariaLabel || option.textContent || '');
          const id = dataValue || ariaLabel || label;
          if (!id || !label || !isLikelyModelLabel(label)) {
            continue;
          }
          return { id, label, selected: true } as ScrapedPerplexityModel;
        }
        return undefined;
      }, PerplexityWebAdapter.MODEL_OPTION_SELECTOR)
      .catch(() => undefined);
  }

  private async readCurrentPickerLabel(): Promise<string> {
    const scoredLabel = await this.readLikelyPickerLabelFromButtons();
    if (scoredLabel) {
      return scoredLabel;
    }
    for (const selector of PerplexityWebAdapter.MODEL_PICKER_CANDIDATES) {
      const trigger = this.page!.locator(selector).first();
      try {
        if ((await trigger.count()) === 0 || !(await trigger.isVisible())) {
          continue;
        }
        const translated = (await trigger.locator('[translate="no"]').first().innerText().catch(() => '')).trim();
        const inner = (await trigger.innerText().catch(() => '')).trim();
        const chosen = this.cleanModelLabel(translated || inner);
        if (chosen) {
          return chosen;
        }
      } catch {
        // Ignore and continue.
      }
    }
    return '';
  }

  private async clickLikelyModelPickerButton(): Promise<boolean> {
    const candidates = this.page!.locator('button[aria-haspopup="menu"], [role="combobox"], button[aria-label*="Model"]');
    const count = Math.min(await candidates.count(), 40);
    let bestIndex = -1;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      try {
        if (!(await candidate.isVisible()) || (await candidate.isDisabled())) {
          continue;
        }
        const ariaLabel = ((await candidate.getAttribute('aria-label')) || '').trim();
        const translated = (await candidate.locator('[translate="no"]').first().innerText().catch(() => '')).trim();
        const inner = (await candidate.innerText().catch(() => '')).trim();
        const label = this.cleanModelLabel(translated || inner || ariaLabel);
        const score = this.scoreLikelyModelPickerLabel(label || ariaLabel);
        if (score > bestScore) {
          bestScore = score;
          bestIndex = index;
        }
      } catch {
        // Ignore transient DOM issues.
      }
    }

    if (bestIndex < 0 || bestScore < 20) {
      return false;
    }

    try {
      await candidates.nth(bestIndex).click().catch(() => undefined);
      return true;
    } catch {
      return false;
    }
  }

  private async readLikelyPickerLabelFromButtons(): Promise<string> {
    const candidates = this.page!.locator('button[aria-haspopup="menu"], [role="combobox"], button[aria-label*="Model"]');
    const count = Math.min(await candidates.count(), 40);
    let bestLabel = '';
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      try {
        if (!(await candidate.isVisible())) {
          continue;
        }
        const ariaLabel = ((await candidate.getAttribute('aria-label')) || '').trim();
        const translated = (await candidate.locator('[translate="no"]').first().innerText().catch(() => '')).trim();
        const inner = (await candidate.innerText().catch(() => '')).trim();
        const label = this.cleanModelLabel(translated || inner || ariaLabel);
        const score = this.scoreLikelyModelPickerLabel(label || ariaLabel);
        if (label && score > bestScore) {
          bestScore = score;
          bestLabel = label;
        }
      } catch {
        // Ignore transient DOM issues.
      }
    }

    return bestScore >= 20 ? bestLabel : '';
  }

  private scoreLikelyModelPickerLabel(value: string): number {
    const normalized = this.normalizeModelToken(value);
    if (!normalized) {
      return Number.NEGATIVE_INFINITY;
    }

    let score = 0;
    if (/model/.test(normalized)) {
      score += 26;
    }
    if (/thinking/.test(normalized)) {
      score += 28;
    }
    if (/(best|sonar|gpt|gemini|claude|kimi|nemotron|llama|qwen|deepseek|mistral|opus|sonnet|haiku|grok|turbo|r\d+|o\d+)/i.test(normalized)) {
      score += 45;
    }
    if (/\d/.test(normalized)) {
      score += 14;
    }
    if (/(search|focus|profile|account|settings|library|thread|new chat|share|copy|upload|attach|tool|computer|agent)/i.test(normalized)) {
      score -= 70;
    }
    return score;
  }

  private normalizeModelToken(value: string): string {
    return this.cleanModelLabel(value)
      .toLowerCase()
      .replace(/[\s_-]+/g, ' ')
      .replace(/[^a-z0-9.]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private cleanModelLabel(value: string): string {
    return value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .replace(/\b(currently selected|selected|recommended)\b/gi, '')
      .trim();
  }

  private matchesModelToken(left: string, right: string): boolean {
    const a = this.normalizeModelToken(left);
    const b = this.normalizeModelToken(right);
    if (!a || !b) {
      return false;
    }
    return a === b || a.includes(b) || b.includes(a);
  }

  private ensureAutoModelFirst(models: ChatModel[]): ChatModel[] {
    const rest = models.filter(
      (entry) =>
        this.normalizeModelToken(entry.id) !== 'auto' &&
        (this.isLikelyPerplexityModelToken(entry.id) || this.isLikelyPerplexityModelToken(entry.label)),
    );
    return [{ id: 'auto', label: 'Auto' }, ...rest];
  }

  private isLikelyPerplexityModelToken(value: string): boolean {
    const normalized = this.normalizeModelToken(value);
    if (!normalized) {
      return false;
    }
    if (normalized === 'auto' || normalized === 'best' || normalized === 'sonar') {
      return true;
    }
    if (/thinking|computer|tool|new chat|settings|help|logout|log out|switch to|upgrade|attach/.test(normalized)) {
      return false;
    }
    if (/\d/.test(normalized)) {
      return true;
    }
    return /(gpt|gemini|claude|kimi|nemotron|llama|qwen|deepseek|mistral|opus|sonnet|haiku|grok|turbo|reasoning|r\d+|o\d+)/i.test(
      normalized,
    );
  }

  private getConversationIdFromUrl(url: string): string | undefined {
    try {
      const parsed = new URL(url);
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts[0] !== 'search' || parts.length < 2) {
        return undefined;
      }
      if (parts[1] === 'new') {
        return undefined;
      }
      return parts[1];
    } catch {
      return undefined;
    }
  }

  private resetQueue(): void {
    this.queue.length = 0;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (waiter?.timer) {
        clearTimeout(waiter.timer);
      }
      waiter?.resolve({ type: 'error', message: 'Previous Perplexity stream was replaced by a new request.' });
    }
  }

  private pushEvent(event: ProviderEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      if (waiter.timer) {
        clearTimeout(waiter.timer);
      }
      waiter.resolve(event);
      return;
    }
    this.queue.push(event);
  }

  private nextEvent(timeoutMs = PerplexityWebAdapter.INTER_EVENT_TIMEOUT_MS): Promise<ProviderEvent> {
    const queued = this.queue.shift();
    if (queued) {
      return Promise.resolve(queued);
    }
    return new Promise((resolve) => {
      const waiter: PendingWaiter = { resolve };
      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) {
            this.waiters.splice(index, 1);
          }
          resolve({ type: 'error', message: `Perplexity response timed out after ${Math.round(timeoutMs / 1000)}s.` });
        }, timeoutMs);
      }
      this.waiters.push(waiter);
    });
  }

  private async ensureHookInstalled(): Promise<void> {
    await this.ensurePage(false);
    await this.ensureOnOrigin();

    if (!this.bindingsInstalled && this.context) {
      await this.context
        .exposeBinding('__webagentPerplexityEmit', (_source, payload: unknown) => {
          const event = payload as ProviderEvent;
          this.pushEvent(event);
        })
        .catch(() => undefined);
      this.bindingsInstalled = true;
    }

    await this.page!
      .evaluate(() => {
        const scope = globalThis as typeof globalThis & {
          __webagentPerplexityHookInstalled?: boolean;
          __webagentPerplexityOriginalFetch?: typeof fetch;
          __webagentPerplexityAbort?: AbortController;
          __webagentPerplexityEmit?: (payload: unknown) => Promise<void>;
          __webagentPerplexityEnableThinking?: boolean;
        };

        if (scope.__webagentPerplexityHookInstalled) {
          return;
        }
        scope.__webagentPerplexityHookInstalled = true;
        scope.__webagentPerplexityOriginalFetch = scope.fetch.bind(scope);

        const decoder = new TextDecoder();

        const emit = async (event: unknown) => {
          try {
            await scope.__webagentPerplexityEmit?.(event);
          } catch {
            // Ignore callback failures.
          }
        };

        const applyThinkingPreference = (payload: unknown, enabled: boolean): boolean => {
          const isPlainObject = (value: unknown): value is Record<string, unknown> =>
            typeof value === 'object' && value !== null && !Array.isArray(value);
          if (!isPlainObject(payload)) {
            return false;
          }

          const visited = new Set<unknown>();
          let changed = false;
          const keyRegex = /(thinking|reasoning|reason)/i;

          const patchValue = (holder: Record<string, unknown>, key: string, value: unknown): void => {
            if (typeof value === 'boolean') {
              if (value !== enabled) {
                holder[key] = enabled;
                changed = true;
              }
              return;
            }
            if (typeof value === 'number') {
              if (value === 0 || value === 1) {
                const next = enabled ? 1 : 0;
                if (value !== next) {
                  holder[key] = next;
                  changed = true;
                }
              }
              return;
            }
            if (typeof value === 'string') {
              const lowered = value.trim().toLowerCase();
              if (/^(true|false)$/.test(lowered)) {
                const next = enabled ? 'true' : 'false';
                if (lowered !== next) {
                  holder[key] = next;
                  changed = true;
                }
                return;
              }
              if (/^(enabled|disabled)$/.test(lowered)) {
                const next = enabled ? 'enabled' : 'disabled';
                if (lowered !== next) {
                  holder[key] = next;
                  changed = true;
                }
                return;
              }
              if (/^(on|off)$/.test(lowered)) {
                const next = enabled ? 'on' : 'off';
                if (lowered !== next) {
                  holder[key] = next;
                  changed = true;
                }
              }
            }
          };

          const visit = (node: unknown, depth: number): void => {
            if (depth > 6 || typeof node !== 'object' || node === null || visited.has(node)) {
              return;
            }
            visited.add(node);

            if (Array.isArray(node)) {
              for (const item of node) {
                visit(item, depth + 1);
              }
              return;
            }

            const record = node as Record<string, unknown>;
            for (const [key, value] of Object.entries(record)) {
              if (keyRegex.test(key)) {
                patchValue(record, key, value);
              }
              visit(value, depth + 1);
            }
          };

          visit(payload, 0);
          return changed;
        };

        const consumeStream = async (stream: ReadableStream<Uint8Array>) => {
          const reader = stream.getReader();
          let buffer = '';
          let currentText = '';
          let chunks: string[] = [];

          const applyPatch = async (patch: { op?: string; path?: string; value?: unknown }) => {
            const patchPath = typeof patch.path === 'string' ? patch.path : '';
            if (patch.op === 'replace' && patchPath === '') {
              const root = patch.value as { chunks?: unknown[] } | undefined;
              if (root && Array.isArray(root.chunks)) {
                chunks = root.chunks.map((entry) => (typeof entry === 'string' ? entry : ''));
              }
            } else if ((patch.op === 'add' || patch.op === 'replace') && /^\/chunks\/\d+$/.test(patchPath)) {
              const index = Number(patchPath.split('/').pop());
              chunks[index] = typeof patch.value === 'string' ? patch.value : '';
            }

            const nextText = chunks.join('');
            if (nextText && nextText !== currentText) {
              const delta = nextText.startsWith(currentText) ? nextText.slice(currentText.length) : nextText;
              currentText = nextText;
              if (delta) {
                void emit({ type: 'delta', text: delta });
              }
            }
          };

          const handlePayload = async (payload: Record<string, unknown>) => {
            const slug = typeof payload.thread_url_slug === 'string' ? payload.thread_url_slug : undefined;
            if (slug) {
              await emit({ type: 'metadata', conversationId: slug });
            }

            const blocks = Array.isArray(payload.blocks) ? payload.blocks : [];
            for (const block of blocks) {
              const entry = block as { intended_usage?: string; diff_block?: { field?: string; patches?: unknown[] } };
              if (!entry || (entry.intended_usage !== 'ask_text' && entry.intended_usage !== 'ask_text_0_markdown')) {
                continue;
              }
              if (entry.diff_block?.field !== 'markdown_block' || !Array.isArray(entry.diff_block.patches)) {
                continue;
              }
              for (const rawPatch of entry.diff_block.patches) {
                await applyPatch((rawPatch || {}) as { op?: string; path?: string; value?: unknown });
              }
            }
          };

          try {
            while (true) {
              const result = await reader.read();
              if (result.done) {
                break;
              }

              buffer += decoder.decode(result.value, { stream: true }).replace(/\r\n/g, '\n');
              while (true) {
                const boundary = buffer.indexOf('\n\n');
                if (boundary === -1) {
                  break;
                }

                const block = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);
                const dataText = block
                  .split('\n')
                  .filter((line) => line.startsWith('data:'))
                  .map((line) => line.slice(5).trim())
                  .join('\n');

                if (!dataText) {
                  continue;
                }

                try {
                  const payload = JSON.parse(dataText) as Record<string, unknown>;
                  await handlePayload(payload);
                } catch {
                  // Ignore partial or non-JSON events.
                }
              }
            }
          } catch (error) {
            const aborted = error instanceof DOMException && error.name === 'AbortError';
            if (!aborted) {
              const message = error instanceof Error ? error.message : String(error);
              await emit({ type: 'error', message: `Perplexity stream failed: ${message}` });
              return;
            }
          }

          await emit({ type: 'done', fullText: currentText });
        };

        scope.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
          const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
          const isAskRequest = requestUrl.includes('/rest/sse/perplexity_ask');
          let nextInit = init;
          let thinkingApplied = false;
          const thinkingPreference =
            typeof scope.__webagentPerplexityEnableThinking === 'boolean' ? scope.__webagentPerplexityEnableThinking : undefined;

          if (isAskRequest && typeof thinkingPreference === 'boolean') {
            try {
              const sourceBody =
                typeof init?.body === 'string'
                  ? init.body
                  : input instanceof Request
                    ? await input.clone().text()
                    : undefined;
              if (sourceBody) {
                const parsed = JSON.parse(sourceBody) as unknown;
                thinkingApplied = applyThinkingPreference(parsed, thinkingPreference);
                if (thinkingApplied) {
                  nextInit = { ...(init || {}), body: JSON.stringify(parsed) };
                  void emit({
                    type: 'status',
                    message: `Perplexity reasoning ${thinkingPreference ? 'enabled' : 'disabled'} for this request.`,
                  });
                }
              }
            } catch {
              // If payload parsing fails, send the original request unchanged.
            }
          }

          let response: Response;
          try {
            response = await scope.__webagentPerplexityOriginalFetch!(input, nextInit);
          } catch (error) {
            if (isAskRequest) {
              const message = error instanceof Error ? error.message : String(error);
              await emit({ type: 'error', message: `Perplexity request failed: ${message}` });
            }
            throw error;
          }
          if (!isAskRequest || !response.body) {
            return response;
          }

          if (!thinkingApplied && thinkingPreference === true) {
            void emit({
              type: 'status',
              message: 'Perplexity reasoning toggle requested, but no compatible reasoning flag was detected in request payload.',
            });
          }

          const branches = response.body.tee();
          void consumeStream(branches[1]);
          return new Response(branches[0], {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        };
      })
      .catch(() => undefined);
  }
}
