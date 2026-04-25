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
  gemini: {
    homeUrl: 'https://gemini.google.com/app',
    input: ['textarea', 'div.ql-editor[contenteditable="true"]', '[contenteditable="true"]'],
    submit: ['button[aria-label*="Send"]', 'button.send-button'],
    assistantMessages: ['message-content', '.model-response-text', '[data-test-id="response"]'],
    models: [{ id: 'auto', label: 'Auto' }],
    stopButton: ['button[aria-label*="Stop"]'],
    newChat: ['button[aria-label*="New chat"]', 'button[mattooltip="New chat"]'],
    modelPicker: ['button[aria-label*="Model"]', '[role="combobox"]'],
    modelOption: ['[role="option"]', '[role="menuitem"]'],
    accountMenu: ['button[aria-label*="Google Account"]', 'button[aria-label*="Account"]', 'button[aria-label*="Profile"]'],
    signOut: ['text=Sign out', 'text=Log out'],
    signIn: ['text=Sign in', 'text=Log in'],
  },
};
