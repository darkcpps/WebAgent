import type { ProviderId } from '../shared/types';
import type { ChatModel } from '../shared/types';

export interface ProviderSelectorMap {
  homeUrl: string;
  input: string[];
  submit: string[];
  assistantMessages: string[];
  models: ChatModel[];
  stopButton?: string[];
  newChat?: string[];
  modelPicker?: string[];
  modelOption?: string[];
  modelExpand?: string[];
  accountMenu?: string[];
  signOut?: string[];
  signIn?: string[];
}

export const selectorRegistry: Record<ProviderId, ProviderSelectorMap> = {
  chatgpt: {
    homeUrl: 'https://chatgpt.com/',
    input: [
      '#prompt-textarea',
      '[data-testid="composer-input"]',
      '[data-testid="composer-input"] textarea',
      '[data-testid="composer-input"][contenteditable="true"]',
      'div.ProseMirror[contenteditable="true"]',
      'textarea',
    ],
    submit: [
      'button[data-testid="composer-submit-button"]',
      'button[data-testid="send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label*="Send"]',
      '[data-testid*="send-button"]',
      '[data-testid*="submit-button"]',
      'button[type="submit"]',
    ],
    assistantMessages: [
      '[data-message-author-role="assistant"]',
      '[data-testid^="conversation-turn-"] [data-message-author-role="assistant"]',
      '[data-testid^="conversation-turn-"]:has([data-message-author-role="assistant"])',
    ],
    models: [{ id: 'auto', label: 'Auto' }],
    stopButton: ['button[data-testid="stop-button"]'],
    newChat: ['a[href="/"]', 'button[aria-label="New chat"]'],
    modelPicker: ['button[data-testid="model-switcher-dropdown-button"]', 'button[aria-label*="Model"]'],
    modelOption: ['[role="option"]', '[data-testid*="model-switcher"] [role="menuitem"]'],
    accountMenu: ['button[aria-label*="Profile"]', 'button[aria-label*="Account"]', 'button[data-testid*="account"]'],
    signOut: ['text=Log out', 'text=Sign out'],
    signIn: ['text=Log in', 'text=Sign in'],
  },
  perplexity: {
    homeUrl: 'https://www.perplexity.ai/',
    input: ['textarea', '[contenteditable="true"]', '[role="textbox"]'],
    submit: [
      'button[aria-label*="Submit"]',
      'button[aria-label*="Send"]',
      'button[type="submit"]',
      '[data-testid*="submit"]',
      '[data-testid*="send"]',
    ],
    assistantMessages: ['[data-testid*="answer"]', '[class*="prose"]', '[class*="markdown"]'],
    models: [{ id: 'auto', label: 'Auto' }],
    stopButton: ['button[aria-label*="Stop"]', '[data-testid*="stop"]'],
    newChat: ['a[href="/"]', 'button[aria-label*="New thread"]', 'button[aria-label*="New chat"]', 'button[aria-label*="Home"]'],
    modelPicker: [
      'button[aria-label*="Model"]',
      '[role="combobox"]',
      'button[aria-haspopup="menu"]:has(span[translate="no"])',
      'button[aria-haspopup="menu"]',
      '[role="button"][aria-haspopup="menu"]',
    ],
    modelOption: ['[role="option"]', '[role="menuitem"]', '[role="menuitemradio"]', '[role="menuitemcheckbox"]', '[data-value]'],
    accountMenu: ['button[aria-label*="Profile"]', 'button[aria-label*="Account"]', 'button[data-testid*="avatar"]'],
    signOut: ['text=Sign out', 'text=Log out'],
    signIn: ['text=Sign in', 'text=Log in'],
  },
  kimi: {
    homeUrl: 'https://www.kimi.com/?chat_enter_method=new_chat',
    input: [
      'textarea[placeholder*="Ask"]',
      'textarea',
      '[contenteditable="true"]',
      '[role="textbox"]',
    ],
    submit: [
      'button[aria-label*="Send"]',
      'button[aria-label*="Submit"]',
      'button[type="submit"]',
      '[data-testid*="send"]',
      '[data-testid*="submit"]',
    ],
    assistantMessages: [
      '[data-role="assistant"]',
      '[class*="assistant"]',
      '[class*="markdown"]',
      '[class*="prose"]',
      'main article',
    ],
    models: [{ id: 'auto', label: 'Kimi K2.6' }],
    stopButton: ['button[aria-label*="Stop"]', '[data-testid*="stop"]'],
    newChat: ['a:has-text("New Chat")', 'button:has-text("New Chat")', 'button[aria-label*="New chat"]'],
    modelPicker: ['button[aria-label*="Model"]', '[role="combobox"]'],
    modelOption: ['[role="option"]', '[role="menuitem"]', '[role="menuitemradio"]', '[data-value]'],
    accountMenu: ['button[aria-label*="Profile"]', 'button[aria-label*="Account"]', 'button[data-testid*="avatar"]'],
    signOut: ['text=Sign out', 'text=Log out'],
    signIn: ['text=Sign in', 'text=Log in'],
  },
  deepseek: {
    homeUrl: 'https://chat.deepseek.com/',
    input: [
      '#chat-input',
      'textarea[placeholder*="DeepSeek"]',
      'textarea[placeholder*="Message"]',
      'textarea[placeholder*="Ask"]',
      'textarea',
      '[contenteditable="true"]',
      '[role="textbox"]',
    ],
    submit: [
      'button[aria-label*="Send"]',
      'button[aria-label*="send"]',
      'button[aria-label*="发送"]',
      'button[aria-label*="Submit"]',
      'button[title*="Send"]',
      'button[title*="send"]',
      'button[title*="发送"]',
      'button:has([class*="send"])',
      'button[class*="send"]',
      'button[type="submit"]',
      '[data-testid*="send"]',
      '[data-testid*="submit"]',
      '.ds-icon-button',
    ],
    assistantMessages: [
      '.ds-markdown',
      '[class*="ds-markdown"]',
      '[class*="markdown"]',
      '[class*="message-content"]',
      '[data-role="assistant"]',
      '[class*="assistant"]',
      '[class*="prose"]',
      'main article',
    ],
    models: [{ id: 'auto', label: 'Auto' }],
    stopButton: [
      'button[aria-label*="Stop"]',
      'button[aria-label*="stop"]',
      'button[aria-label*="停止"]',
      'button[title*="Stop"]',
      'button[title*="stop"]',
      'button[title*="停止"]',
      'button:has([class*="stop"])',
      '[data-testid*="stop"]',
    ],
    newChat: [
      'a[href="/"]',
      'a[href="/a/chat"]',
      'button:has-text("New chat")',
      'button:has-text("New Chat")',
      'button[aria-label*="New chat"]',
    ],
    modelPicker: ['button[aria-label*="Model"]', '[role="combobox"]'],
    modelOption: ['[role="option"]', '[role="menuitem"]', '[role="menuitemradio"]', '[data-value]'],
    accountMenu: ['button[aria-label*="Profile"]', 'button[aria-label*="Account"]', 'button[data-testid*="avatar"]'],
    signOut: ['text=Sign out', 'text=Log out'],
    signIn: ['text=Sign in', 'text=Log in'],
  },
};
