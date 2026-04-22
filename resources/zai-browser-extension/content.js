const SELECTORS = {
  input: ["#chat-input", "textarea#chat-input", "textarea", "[contenteditable='true']"],
  submit: [
    "#send-message-button",
    "button#send-message-button",
    "button[aria-label='Send Message']",
    "button[type='submit']",
    "button[data-testid*='send']",
  ],
  assistant: [
    "#response-content-container",
    ".chat-assistant .markdown-prose",
    ".chat-assistant",
    "[data-role='assistant']",
    "p[dir='auto']",
  ],
  stop: ["button[aria-label*='Stop']", "button[data-testid*='stop']", "button:has(svg.size-5):not(.copy-response-button):not(.regenerate-response-button)"],
  newChat: ["button[aria-label*='New chat']", "a[href='/']"],
  modelPicker: ["button[aria-label='Select a model']", "button[aria-label*='model']", "button:has(svg.lucide-chevron-down)", "[role='combobox']"],
  modelOption: ["div[role='option']", "li[role='option']", "button[aria-label='model-item'][data-value]", "button[data-value]", "[role='option']", "[role='menuitem']", ".model-item"],
  modelExpand: [],
  signIn: ["a[href*='login']", "button:contains('Sign in')", "button:contains('Log in')"],
};

let activeStream = null;

function randomId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function queryFirstVisible(selectors) {
  for (const selector of selectors) {
    let node = null;
    try {
      node = document.querySelector(selector);
    } catch {
      continue;
    }
    if (!node) {
      continue;
    }
    const rect = node.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      return node;
    }
  }
  return null;
}

function queryAll(selectors) {
  const nodes = [];
  for (const selector of selectors) {
    let found = [];
    try {
      found = document.querySelectorAll(selector);
    } catch {
      continue;
    }
    for (const node of found) {
      nodes.push(node);
    }
  }
  return nodes;
}

function sanitizeText(text) {
  return (text || "").replace(/\r/g, "").replace(/\u00a0/g, " ").replace(/\n\s*\n\s*\n/g, "\n\n").trim();
}

function parseConversationId(url) {
  const match = (url || window.location.href).match(/\/c\/([A-Za-z0-9-]{8,})/);
  return match ? match[1] : undefined;
}

function readLatestAssistantText() {
  const containers = queryAll(SELECTORS.assistant);
  const candidates = [];
  
  for (const container of containers) {
    if (container.closest("[class*='user'], [class*='human'], [class*='avatar-u'], [data-role='user']")) {
      continue;
    }

    const rect = container.getBoundingClientRect();
    if (rect.bottom <= 0 || rect.width === 0 || rect.height === 0) {
      continue;
    }

    // Work on a detached clone to not mess up UI
    const clone = container.cloneNode(true);
    let thoughtText = "";
    
    // Find thinking blocks by CSS class
    const thinkBlocks = clone.querySelectorAll(".thinking-block, .thinking-chain-container");
    for (const block of thinkBlocks) {
      // The user specified that the actual thought process inside is often inside a blockquote
      const quote = block.querySelector("blockquote");
      if (quote) {
        thoughtText += quote.innerText + "\n\n";
      } else {
        thoughtText += block.innerText + "\n\n";
      }
      block.remove(); // Remove it from the clone so it doesn't appear in finalText
    }
    
    // Find any remaining "Thought Process" text labels just in case and remove their wrappers
    const labelWalker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
    let n = labelWalker.nextNode();
    while (n) {
      const text = (n.nodeValue || "").trim();
      if (text === "Thought Process" || text === "Thinking Chain") {
        let p = n.parentElement;
        if (p) {
           let marker = p;
           while (marker && marker.parentElement && marker.parentElement !== clone) {
             if (marker.nextElementSibling) {
               thoughtText += marker.nextElementSibling.innerText + "\n\n";
               marker.nextElementSibling.remove();
               break;
             }
             marker = marker.parentElement;
           }
           p.remove();
        }
      }
      n = labelWalker.nextNode();
    }
    
    // Extract the remaining text as final answer
    let finalText = clone.innerText || "";
    
    // Synthesize them cleanly
    let synthesized = "";
    if (thoughtText.trim()) {
      synthesized += `<think>\n${thoughtText.trim()}\n</think>\n\n`;
    }
    synthesized += finalText.trim();
    
    candidates.push({ text: synthesized.trim(), bottom: rect.bottom });
  }

  if (!candidates.length) {
    return "";
  }

  candidates.sort((a, b) => b.bottom - a.bottom || b.text.length - a.text.length);
  return candidates[0].text;
}

function stopButtonVisible() {
  return Boolean(queryFirstVisible(SELECTORS.stop));
}

function emitStreamEvent(streamId, event) {
  chrome.runtime.sendMessage({
    type: "zai-bridge-event",
    streamId,
    event,
  });
}

function stopActiveStream() {
  if (!activeStream) {
    return;
  }
  clearInterval(activeStream.tickTimer);
  clearTimeout(activeStream.hardTimeout);
  activeStream.observer.disconnect();
  activeStream = null;
}

function maybeEmitMetadata(streamState) {
  const cid = parseConversationId();
  if (cid && cid !== streamState.lastConversationId) {
    streamState.lastConversationId = cid;
    emitStreamEvent(streamState.streamId, {
      type: "metadata",
      conversationId: cid,
    });
  }
}

function maybeEmitDelta(streamState, freshText) {
  const normalized = freshText || "";
  if (!normalized) {
    maybeEmitMetadata(streamState);
    streamState.stableTicks += 1;
    return;
  }

  maybeEmitMetadata(streamState);

  if (!streamState.hasNewContent && normalized === streamState.initialText) {
    streamState.stableTicks += 1;
    return;
  }

  if (normalized === streamState.lastText) {
    streamState.stableTicks += 1;
    return;
  }

  if (!streamState.hasNewContent) {
    streamState.hasNewContent = true;
    if (streamState.initialText && normalized.startsWith(streamState.initialText)) {
      streamState.lastText = streamState.initialText;
    }
  }

  let delta = "";
  if (streamState.lastText && normalized.startsWith(streamState.lastText)) {
    delta = normalized.slice(streamState.lastText.length);
  } else if (!streamState.lastText) {
    delta = normalized;
  } else {
    delta = normalized;
  }

  streamState.lastText = normalized;
  streamState.stableTicks = 0;

  if (delta) {
    emitStreamEvent(streamState.streamId, {
      type: "delta",
      text: delta,
    });
  }
}

let apiInterceptedText = null;
let apiInterceptedReasoning = "";
let apiInterceptedContent = "";
let isApiStreamFinished = false;
let lastApiStartAt = 0;

window.addEventListener('message', (event) => {
    if (event.data?.type === 'ZAI_API_START') {
        lastApiStartAt = Date.now();
        apiInterceptedReasoning = "";
        apiInterceptedContent = "";
        apiInterceptedText = "";
        isApiStreamFinished = false;
    } else if (event.data?.type === 'ZAI_API_CHUNK') {
        const payload = event.data.data;
        if (payload?.type === "chat:completion" && payload.data) {
             const chunkData = payload.data;
             if (chunkData.phase === "thinking" && chunkData.delta_content) {
                 apiInterceptedReasoning += chunkData.delta_content;
             } else if (chunkData.phase === "answer" && chunkData.delta_content) {
                 apiInterceptedContent += chunkData.delta_content;
             } else if (chunkData.phase === "done" && chunkData.done === true) {
                 isApiStreamFinished = true;
             }
             
             let synthesized = "";
             if (apiInterceptedReasoning) {
                 synthesized += `<think>\n${apiInterceptedReasoning.trim()}\n</think>\n\n`;
             }
             if (apiInterceptedContent) {
                 synthesized += apiInterceptedContent.trim();
             }
             apiInterceptedText = synthesized.trim();
        }
    } else if (event.data?.type === 'ZAI_API_DONE' || event.data?.type === 'ZAI_API_ERROR') {
        isApiStreamFinished = true;
    }
});

function startStreaming() {
  stopActiveStream();

  const streamId = randomId("stream");
  const initialText = readLatestAssistantText();
  const streamState = {
    streamId,
    initialText,
    lastText: initialText,
    lastConversationId: parseConversationId(),
    hasNewContent: false,
    sawGenerating: false,
    stableTicks: 0,
    observer: null,
    tickTimer: null,
    hardTimeout: null,
  };

  streamState.observer = new MutationObserver(() => {
    if (apiInterceptedText === null) {
      maybeEmitDelta(streamState, readLatestAssistantText());
    }
  });
  streamState.observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  streamState.tickTimer = setInterval(() => {
    const generating = stopButtonVisible();
    if (generating) {
      streamState.sawGenerating = true;
    }

    const text = apiInterceptedText !== null ? apiInterceptedText : readLatestAssistantText();
    maybeEmitDelta(streamState, text);

    if (apiInterceptedText !== null) {
      if (isApiStreamFinished) {
        emitStreamEvent(streamState.streamId, {
          type: "done",
          fullText: apiInterceptedText,
        });
        apiInterceptedText = null;
        stopActiveStream();
        return;
      }
    } else {
      const seemsDone = !generating && streamState.hasNewContent && streamState.stableTicks >= 3;

      if (seemsDone && streamState.lastText) {
        emitStreamEvent(streamState.streamId, {
          type: "done",
          fullText: streamState.lastText,
        });
        stopActiveStream();
        return;
      }

      if (!generating && !streamState.hasNewContent && streamState.stableTicks >= 12) {
        emitStreamEvent(streamState.streamId, {
          type: "error",
          message: "No new assistant response detected. Prompt may not have been submitted.",
        });
        stopActiveStream();
      }
    }
  }, 200); // 200ms tick for much smoother native streaming updates

  streamState.hardTimeout = setTimeout(() => {
    emitStreamEvent(streamState.streamId, {
      type: "error",
      message: "Streaming timed out waiting for z.ai response.",
    });
    stopActiveStream();
  }, 180000);

  activeStream = streamState;
  return streamId;
}

function setComposerValue(composer, text) {
  const normalized = text || "";
  if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
    // Use the native input value setter to bypass React's synthetic event system
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    )?.set || Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    )?.set;

    if (nativeSetter) {
      nativeSetter.call(composer, normalized);
    } else {
      composer.value = normalized;
    }
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    composer.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }

  // contenteditable
  composer.innerText = normalized;
  composer.dispatchEvent(new InputEvent("input", { bubbles: true, data: normalized }));
}

function readComposerValue(composer) {
  if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
    return composer.value || "";
  }
  return composer.innerText || composer.textContent || "";
}

function isComposerEmpty(composer) {
  return sanitizeText(readComposerValue(composer)).length === 0;
}

async function confirmPromptSubmission(composer) {
  const baselineApiStart = lastApiStartAt;
  for (let i = 0; i < 20; i++) {
    await wait(100);
    if (lastApiStartAt > baselineApiStart || stopButtonVisible() || isComposerEmpty(composer)) {
      return true;
    }
  }
  return false;
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function generateConversationId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2, 10)}-${Math.random().toString(16).slice(2, 10)}`;
}

function findNewChatControl() {
  const fromSelectors = queryFirstVisible(SELECTORS.newChat);
  if (fromSelectors) {
    return fromSelectors;
  }

  const candidates = Array.from(document.querySelectorAll("button, a, [role='button'], [role='menuitem']"));
  for (const node of candidates) {
    const element = node;
    if (!element || typeof element.getBoundingClientRect !== "function") {
      continue;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      continue;
    }

    const text = sanitizeText(element.textContent || "").toLowerCase();
    const aria = sanitizeText(element.getAttribute("aria-label") || "").toLowerCase();
    const title = sanitizeText(element.getAttribute("title") || "").toLowerCase();
    const href = sanitizeText(element.getAttribute("href") || "").toLowerCase();
    const combined = `${text} ${aria} ${title} ${href}`;
    if (/\bnew\s*chat\b/.test(combined) || /\bnew\s*conversation\b/.test(combined) || href === "/") {
      return element;
    }
  }

  return null;
}

async function runSendPrompt(params) {
  const composer = queryFirstVisible(SELECTORS.input);
  if (!composer) {
    throw new Error("Unable to find z.ai prompt input.");
  }
  const userPrompt = String(params.userPrompt || "").trim();
  const systemPrompt = String(params.systemPrompt || "").trim();
  const fullPrompt = [systemPrompt, userPrompt].filter(Boolean).join("\n\n");

  composer.focus();
  if (composer.click) {
    composer.click();
  }
  setComposerValue(composer, fullPrompt);
  await wait(300);

  // Try submit button first
  const submit = queryFirstVisible(SELECTORS.submit);
  if (submit && !submit.disabled) {
    submit.click();
    if (await confirmPromptSubmission(composer)) {
      return { submitted: true };
    }
  }

  // If button is disabled, wait a moment for React state to catch up and retry
  await wait(500);
  const retrySubmit = queryFirstVisible(SELECTORS.submit);
  if (retrySubmit && !retrySubmit.disabled) {
    retrySubmit.click();
    if (await confirmPromptSubmission(composer)) {
      return { submitted: true };
    }
  }

  // Fallback: try Enter key
  const enterEvent = {
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
  };
  composer.dispatchEvent(
    new KeyboardEvent("keydown", enterEvent),
  );
  composer.dispatchEvent(
    new KeyboardEvent("keypress", enterEvent),
  );
  composer.dispatchEvent(
    new KeyboardEvent("keyup", enterEvent),
  );

  if (await confirmPromptSubmission(composer)) {
    return { submitted: true };
  }

  throw new Error("Prompt submit could not be confirmed in z.ai UI.");

}

async function runCheckReady() {
  const input = queryFirstVisible(SELECTORS.input);
  const signInLink = queryFirstVisible(SELECTORS.signIn);
  const authHint = Array.from(document.querySelectorAll("button, a"))
    .map((node) => sanitizeText(node.textContent || "").toLowerCase())
    .some((text) => text === "sign in" || text === "log in");
  return {
    ready: Boolean(input),
    loginRequired: !input && (Boolean(signInLink) || authHint),
  };
}

async function runStartNewConversation() {
  const previousConversationId = parseConversationId(window.location.href);
  const composer = queryFirstVisible(SELECTORS.input);
  if (composer) {
    setComposerValue(composer, "");
  }

  const button = findNewChatControl();
  if (button && button.click) {
    button.click();
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await wait(100);
    const currentConversationId = parseConversationId(window.location.href);
    if (currentConversationId && currentConversationId !== previousConversationId) {
      return {
        conversationId: currentConversationId,
        navigating: false,
      };
    }
    if (!currentConversationId) {
      return {
        conversationId: undefined,
        navigating: false,
      };
    }
  }

  // SPA fallback: force a unique conversation route without page unload prompts.
  const fallbackConversationId = generateConversationId();
  const fallbackPath = `/c/${fallbackConversationId}`;
  try {
    window.history.pushState({}, "", fallbackPath);
    window.dispatchEvent(new PopStateEvent("popstate"));
    window.dispatchEvent(new Event("locationchange"));
  } catch {
    // ignore
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    await wait(100);
    const currentConversationId = parseConversationId(window.location.href);
    if (currentConversationId === fallbackConversationId) {
      return {
        conversationId: currentConversationId,
        navigating: false,
      };
    }
  }

  // Last-resort return so caller can still track a new thread id and avoid reusing the previous one.
  return {
    conversationId: fallbackConversationId,
    navigating: false,
  };
}

async function runOpenConversation(params) {
  const conversationId = String(params.conversationId || "").trim();
  if (!conversationId) {
    return { opened: false };
  }
  
  const currentId = parseConversationId(window.location.href);
  if (currentId === conversationId) {
    return { opened: true, navigating: false };
  }

  const target = `https://chat.z.ai/c/${conversationId}`;
  window.location.assign(target);

  return { opened: true, navigating: true };
}

async function runListModels() {
  let picker = queryFirstVisible(SELECTORS.modelPicker);
  
  // Fallback: look for an element stating the active model
  if (!picker) {
    const activeIndicators = Array.from(document.querySelectorAll("button, div")).filter(el => {
      const txt = (el.textContent || "").trim();
      return /GLM-[0-9]/.test(txt) && !el.closest(".chat-assistant");
    });
    if (activeIndicators.length > 0) {
       picker = activeIndicators[0];
       // Go up to find the actual clickable button if we hit a text span
       const btnParent = picker.closest('button, [role="combobox"]');
       if (btnParent) picker = btnParent;
    }
  }

  if (!picker) {
    return { models: [] };
  }
  
  picker.click();
  await wait(800); // Wait longer for the menu to open, React might be slow

  const models = [];
  const seen = new Set();
  let options = queryAll(SELECTORS.modelOption);
  
  if (options.length === 0) {
    await wait(400); // Try waiting a bit more
    options = queryAll(SELECTORS.modelOption);
  }
  
  // If no options found, try to find items inside the popover/menu or search by known text
  let candidates = options.length > 0 ? options : Array.from(document.querySelectorAll("[role='menu'] button, [role='listbox'] button, .popover button, [role='menu'] div, [role='listbox'] div, .model-item"));

  // Super fallback: find elements by text
  if (candidates.length === 0) {
    const knownModels = ["GLM-5.1", "GLM-5-Turbo", "GLM-5V-Turbo", "GLM-5", "GLM-4.7", "GLM-4.6V", "GLM-4.5-Air"];
    candidates = Array.from(document.querySelectorAll("div, li, button, span")).filter(el => {
      const txt = (el.textContent || "").trim();
      return knownModels.includes(txt) || /^GLM-/.test(txt);
    });
  }

  for (const option of candidates) {
    const id = sanitizeText(option.getAttribute("data-value") || option.getAttribute("id") || "");
    let label = sanitizeText((option.innerText || option.textContent || "").split(/\r?\n/)[0] || "");
    label = label || id;
    
    // Ignore empty or very long strings
    if (!label || label.length < 2 || label.length > 80) {
      continue;
    }

    const key = (id || label).toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    
    models.push({
      id: id || label,
      label,
    });
  }

  // Try to close the picker
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, keyCode: 27 }));
  await wait(200);
  
  return { models: models.slice(0, 60) };
}

async function runSelectModel(params) {
  const target = String(params.modelId || "").trim().toLowerCase();
  if (!target) {
    return { ok: true };
  }
  const picker = queryFirstVisible(SELECTORS.modelPicker);
  if (!picker) {
    return { ok: false };
  }

  picker.click();
  await wait(200);
  for (const option of queryAll(SELECTORS.modelOption)) {
    const text = sanitizeText(option.getAttribute("data-value") || option.innerText || "");
    if (text.toLowerCase() === target || text.toLowerCase().includes(target)) {
      option.click();
      await wait(100);
      return { ok: true };
    }
  }
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  return { ok: false };
}

async function runStop() {
  const stop = queryFirstVisible(SELECTORS.stop);
  if (stop && stop.click) {
    stop.click();
  }
  stopActiveStream();
  return { stopped: true };
}

async function handle(method, params) {
  switch (method) {
    case "health": {
      const ready = await runCheckReady();
      return {
        browserConnected: true,
        ...ready,
      };
    }
    case "checkReady":
      return runCheckReady();
    case "startNewConversation":
      return runStartNewConversation();
    case "openConversation":
      return runOpenConversation(params);
    case "getCurrentConversationId":
      return { conversationId: parseConversationId(window.location.href) };
    case "listModels":
      return runListModels();
    case "selectModel":
      return runSelectModel(params);
    case "sendPrompt":
      return runSendPrompt(params);
    case "streamStart":
      return { streamId: startStreaming() };
    case "stop":
      return runStop();
    default:
      throw new Error(`Unsupported bridge method: ${method}`);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "zai-bridge") {
    return false;
  }

  handle(message.method, message.params || {})
    .then((result) => {
      sendResponse(result);
    })
    .catch((error) => {
      sendResponse({
        error: error instanceof Error ? error.message : String(error),
      });
    });

  return true;
});
