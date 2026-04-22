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
  modelPicker: ["button[aria-label='Select a model']", "button[aria-label*='model']", "[role='combobox']"],
  modelOption: ["button[aria-label='model-item'][data-value]", "button[data-value]", "[role='option']", "[role='menuitem']"],
  modelExpand: [],
  signIn: ["a[href*='login']"],
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
    // Skip if this is actually a user message container
    if (container.closest("[class*='user'], [class*='human'], [class*='avatar-u'], [data-role='user']")) {
      continue;
    }

    const rect = container.getBoundingClientRect();
    if (rect.bottom <= 0 || rect.width === 0 || rect.height === 0) {
      continue;
    }

    // Instead of taking the whole parent, we look at children to filter out Thinking
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT);
    let fullTextParts = [];
    let node = walker.nextNode();
    
    while (node) {
      const isThinkBlock = node.classList.contains("thinking-chain-container") || 
                           node.classList.contains("thinking-block") ||
                           node.closest(".thinking-chain-container") || 
                           node.closest(".thinking-block");

      if (isThinkBlock) {
        node = walker.nextNode();
        continue;
      }
                           
      const hasThinkText = node.textContent?.includes("Thought Process") || 
                           node.textContent?.includes("Thinking Chain");

      // If it's a leaf-ish element or specific text-rich tag
      if (!hasThinkText && (node.tagName === "P" || node.tagName === "LI")) {
        const text = sanitizeText(node.innerText || "");
        if (text) {
          fullTextParts.push(text);
          // After taking text from a P or LI, we skip its internal children to avoid duplicates
          let next = walker.nextSibling();
          if (!next) {
             next = walker.nextNode(); // Fallback if no sibling
          }
          node = next;
          continue;
        }
      }
      node = walker.nextNode();
    }

    const joinedText = fullTextParts.join("\n\n").trim();
    if (joinedText) {
      candidates.push({ text: joinedText, bottom: rect.bottom });
    }
  }

  if (!candidates.length) {
    // Fallback to simpler scraping if pinpointing failed
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
  if (!freshText) {
    maybeEmitMetadata(streamState);
    return;
  }

  maybeEmitMetadata(streamState);

  if (freshText === streamState.lastText) {
    streamState.stableTicks += 1;
    return;
  }

  let delta = "";
  if (freshText.startsWith(streamState.lastText)) {
    delta = freshText.slice(streamState.lastText.length);
  } else if (!streamState.lastText) {
    delta = freshText;
  } else {
    delta = freshText;
  }

  streamState.lastText = freshText;
  streamState.stableTicks = 0;

  if (delta) {
    emitStreamEvent(streamState.streamId, {
      type: "delta",
      text: delta,
    });
  }
}

function startStreaming() {
  stopActiveStream();
  const streamId = randomId("stream");
  const streamState = {
    streamId,
    lastText: readLatestAssistantText(),
    lastConversationId: parseConversationId(),
    stableTicks: 0,
    observer: null,
    tickTimer: null,
    hardTimeout: null,
  };

  streamState.observer = new MutationObserver(() => {
    maybeEmitDelta(streamState, readLatestAssistantText());
  });
  streamState.observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  streamState.tickTimer = setInterval(() => {
    const text = readLatestAssistantText();
    maybeEmitDelta(streamState, text);

    const generating = stopButtonVisible();
    if (!generating && streamState.lastText && streamState.stableTicks >= 3) {
      emitStreamEvent(streamState.streamId, {
        type: "done",
        fullText: streamState.lastText,
      });
      stopActiveStream();
      return;
    }

    if (!generating && !streamState.lastText && streamState.stableTicks >= 12) {
      emitStreamEvent(streamState.streamId, {
        type: "error",
        message: "No assistant response detected in z.ai DOM.",
      });
      stopActiveStream();
    }
  }, 500);

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

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
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
    return { submitted: true };
  }

  // If button is disabled, wait a moment for React state to catch up and retry
  await wait(500);
  const retrySubmit = queryFirstVisible(SELECTORS.submit);
  if (retrySubmit && !retrySubmit.disabled) {
    retrySubmit.click();
    return { submitted: true };
  }

  // Fallback: try Enter key
  composer.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
    }),
  );
  return { submitted: true };

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
  const button = queryFirstVisible(SELECTORS.newChat);
  if (button && button.click) {
    button.click();
    await wait(400);
  } else if (!window.location.pathname || window.location.pathname !== "/") {
    window.location.assign("https://chat.z.ai/");
    await wait(600);
  }
  return {
    conversationId: parseConversationId(window.location.href),
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
  const picker = queryFirstVisible(SELECTORS.modelPicker);
  if (!picker) {
    return { models: [] };
  }
  picker.click();
  await wait(200);

  const models = [];
  for (const option of queryAll(SELECTORS.modelOption)) {
    const value = sanitizeText(option.getAttribute("data-value") || option.innerText || "");
    if (!value || value.length < 2 || value.length > 80) {
      continue;
    }
    if (!models.includes(value)) {
      models.push(value);
    }
  }

  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
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
