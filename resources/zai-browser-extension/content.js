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
  stop: [
    "button[aria-label*='Stop']",
    "button[aria-label*='stop']",
    "button[data-testid*='stop']",
    "button[title*='Stop']",
    "[role='button'][aria-label*='Stop']",
  ],
  newChat: ["button[aria-label*='New chat']", "a[href='/']"],
  modelPicker: ["button[aria-label='Select a model']", "button[aria-label*='model']", "button:has(svg.lucide-chevron-down)", "[role='combobox']"],
  modelOption: ["div[role='option']", "li[role='option']", "button[aria-label='model-item'][data-value]", "button[data-value]", "[role='option']", "[role='menuitem']", ".model-item"],
  modelExpand: [],
  signIn: ["a[href*='login']", "button:contains('Sign in')", "button:contains('Log in')"],
};

let activeStream = null;
let wakeLock = null;
let audioContext = null;
const MODEL_STATE_KEY = "zai-bridge:model-state";
const modelState = {
  selectedModelId: undefined,
  selectedModelLabel: undefined,
  enableThinking: undefined,
  models: [],
  defaultModelId: undefined,
};
let modelStateReady;

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        console.log('[zai-bridge] Wake Lock was released');
      });
    }
  } catch (err) {
    console.error(`[zai-bridge] Wake Lock failed: ${err.name}, ${err.message}`);
  }
}

function startSilentAudio() {
  if (audioContext && audioContext.state === 'running') return;
  try {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    
    // Create a silent buffer to play
    const buffer = audioContext.createBuffer(1, 1, 22050);
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(audioContext.destination);
    source.start();
    
    // Also try oscillator for more "activity"
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    gainNode.gain.value = 0.0001; // Extremely quiet but still there
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    oscillator.start();

    if (audioContext.state === 'suspended') {
      audioContext.resume();
    }
    console.log('[zai-bridge] Silent audio keep-alive started');
  } catch (err) {
    console.warn('[zai-bridge] Could not start silent audio', err);
  }
}

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

function toCleanString(value) {
  if (typeof value !== "string") {
    return "";
  }
  return sanitizeText(value);
}

function asBooleanOrUndefined(value) {
  if (value === true || value === false) {
    return value;
  }
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (lowered === "true") {
      return true;
    }
    if (lowered === "false") {
      return false;
    }
  }
  return undefined;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function readObjectPath(value, path) {
  let cursor = value;
  for (const key of path) {
    if (!cursor || typeof cursor !== "object" || !(key in cursor)) {
      return undefined;
    }
    cursor = cursor[key];
  }
  return cursor;
}

function postBridgePreferencesToPage() {
  window.postMessage(
    {
      type: "ZAI_BRIDGE_SET_PREFERENCES",
      payload: {
        modelId: modelState.selectedModelId,
        modelLabel: modelState.selectedModelLabel,
        enableThinking: modelState.enableThinking,
      },
    },
    "*",
  );
}

async function persistModelState() {
  try {
    await chrome.storage.local.set({
      [MODEL_STATE_KEY]: {
        selectedModelId: modelState.selectedModelId,
        selectedModelLabel: modelState.selectedModelLabel,
        enableThinking: modelState.enableThinking,
        defaultModelId: modelState.defaultModelId,
      },
    });
  } catch (error) {
    console.warn("[zai-bridge] Failed to persist model state:", error);
  }
}

async function ensureModelStateLoaded() {
  if (!modelStateReady) {
    modelStateReady = (async () => {
      try {
        const stored = await chrome.storage.local.get([MODEL_STATE_KEY]);
        const payload = stored?.[MODEL_STATE_KEY];
        if (payload && typeof payload === "object") {
          modelState.selectedModelId = toCleanString(payload.selectedModelId) || undefined;
          modelState.selectedModelLabel = toCleanString(payload.selectedModelLabel) || undefined;
          modelState.defaultModelId = toCleanString(payload.defaultModelId) || undefined;
          modelState.enableThinking = asBooleanOrUndefined(payload.enableThinking);
        }
      } catch (error) {
        console.warn("[zai-bridge] Failed to load model state:", error);
      }
      postBridgePreferencesToPage();
    })();
  }
  await modelStateReady;
}

function normalizeModelOption(rawModel) {
  if (!rawModel) {
    return undefined;
  }

  if (typeof rawModel === "string") {
    const value = toCleanString(rawModel);
    if (!value) {
      return undefined;
    }
    return { id: value, name: value, raw: rawModel };
  }

  if (typeof rawModel !== "object") {
    return undefined;
  }

  const record = rawModel;
  const idCandidates = [
    record.id,
    record.model_id,
    record.modelId,
    record.backend_id,
    record.backendId,
    record.value,
    record.code,
    record.slug,
    record.model,
    record.key,
    record.name_en,
    record.name,
  ];
  const nameCandidates = [
    record.name,
    record.label,
    record.display_name,
    record.displayName,
    record.title,
    record.model_name,
    record.alias,
    record.text,
    record.id,
  ];
  const descriptionCandidates = [record.description, record.desc, record.intro, record.summary];

  const id = idCandidates.map(toCleanString).find(Boolean) || "";
  const name = nameCandidates.map(toCleanString).find(Boolean) || id;
  const description = descriptionCandidates.map(toCleanString).find(Boolean) || undefined;

  if (!id || !name) {
    return undefined;
  }

  return { id, name, description, raw: rawModel };
}

function collectModelCandidates(value, output, depth = 0) {
  if (depth > 6 || value == null) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectModelCandidates(item, output, depth + 1);
    }
    return;
  }

  if (typeof value !== "object") {
    return;
  }

  const normalized = normalizeModelOption(value);
  if (normalized) {
    output.push(normalized);
  }

  for (const nested of Object.values(value)) {
    if (Array.isArray(nested) || (nested && typeof nested === "object")) {
      collectModelCandidates(nested, output, depth + 1);
    }
  }
}

function dedupeModelOptions(models) {
  const seen = new Set();
  const deduped = [];

  for (const model of models) {
    if (!model || !model.id) {
      continue;
    }
    const key = model.id.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(model);
  }

  return deduped;
}

function pickDefaultModelId(rawModels, rawConfig) {
  const directCandidates = [
    readObjectPath(rawConfig, ["default_model"]),
    readObjectPath(rawConfig, ["defaultModel"]),
    readObjectPath(rawConfig, ["model"]),
    readObjectPath(rawConfig, ["model_id"]),
    readObjectPath(rawConfig, ["modelId"]),
    readObjectPath(rawConfig, ["chat", "model"]),
    readObjectPath(rawConfig, ["chat", "models", 0]),
    readObjectPath(rawModels, ["default_model"]),
    readObjectPath(rawModels, ["defaultModel"]),
    readObjectPath(rawModels, ["model"]),
    readObjectPath(rawModels, ["model_id"]),
    readObjectPath(rawModels, ["modelId"]),
  ];
  const direct = directCandidates.map(toCleanString).find(Boolean);
  if (direct) {
    return direct;
  }

  const recursiveDefault = (value, depth = 0) => {
    if (depth > 5 || value == null) {
      return undefined;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = recursiveDefault(item, depth + 1);
        if (found) {
          return found;
        }
      }
      return undefined;
    }
    if (typeof value !== "object") {
      return undefined;
    }
    const record = value;
    const isDefault = record.default === true || record.is_default === true || record.isDefault === true || record.selected === true;
    if (isDefault) {
      const normalized = normalizeModelOption(record);
      if (normalized?.id) {
        return normalized.id;
      }
    }
    for (const nested of Object.values(record)) {
      const found = recursiveDefault(nested, depth + 1);
      if (found) {
        return found;
      }
    }
    return undefined;
  };

  return recursiveDefault(rawModels) || recursiveDefault(rawConfig);
}

async function fetchJsonEndpoint(url) {
  const response = await fetch(url, {
    method: "GET",
    credentials: "include",
    headers: {
      accept: "application/json, text/plain, */*",
    },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return await response.json();
}

async function discoverModelsFromApi() {
  let rawModels;
  let rawConfig;

  try {
    rawModels = await fetchJsonEndpoint("https://chat.z.ai/api/models");
  } catch (error) {
    console.warn("[zai-bridge] /api/models failed:", error);
    return { models: [], defaultModelId: undefined, source: "fallback" };
  }

  try {
    rawConfig = await fetchJsonEndpoint("https://chat.z.ai/api/config");
  } catch (error) {
    console.warn("[zai-bridge] /api/config fallback failed:", error);
  }

  const candidates = [];
  collectModelCandidates(rawModels, candidates);
  const models = dedupeModelOptions(candidates);
  const defaultModelId = pickDefaultModelId(rawModels, rawConfig);

  return { models, defaultModelId, source: "api" };
}

function formatModelOptionsForUi(models) {
  return models.map((model) => ({
    id: model.id,
    label: model.name || model.id,
    description: model.description,
  }));
}

function alignSelectedModelWithAvailableModels() {
  if (!modelState.models.length) {
    return;
  }

  const exists = (candidate) =>
    Boolean(candidate) && modelState.models.some((model) => model.id.toLowerCase() === candidate.toLowerCase());

  if (exists(modelState.selectedModelId)) {
    const active = modelState.models.find((model) => model.id.toLowerCase() === modelState.selectedModelId.toLowerCase());
    modelState.selectedModelLabel = active?.name || modelState.selectedModelLabel;
    return;
  }

  const preferredFallback = [modelState.defaultModelId, modelState.models[0]?.id].find((candidate) => exists(candidate));
  if (!preferredFallback) {
    return;
  }

  modelState.selectedModelId = preferredFallback;
  const active = modelState.models.find((model) => model.id.toLowerCase() === preferredFallback.toLowerCase());
  modelState.selectedModelLabel = active?.name || preferredFallback;
  console.warn(`[zai-bridge] Saved model unavailable. Falling back to ${modelState.selectedModelLabel} (${modelState.selectedModelId}).`);
}

function isNodeVisible(node) {
  if (!node || !(node instanceof Element)) {
    return false;
  }
  if (!node.isConnected) {
    return false;
  }
  const rect = node.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }
  const style = window.getComputedStyle(node);
  if (style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none") {
    return false;
  }
  if (Number(style.opacity || "1") === 0) {
    return false;
  }
  return true;
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
  const directMatches = queryAll(SELECTORS.stop);
  const fallbackMatches = Array.from(document.querySelectorAll("button, [role='button']"));
  const candidates = [...directMatches, ...fallbackMatches];

  for (const node of candidates) {
    if (!isNodeVisible(node)) {
      continue;
    }

    const disabled = node.hasAttribute("disabled") || String(node.getAttribute("aria-disabled") || "").toLowerCase() === "true";
    if (disabled) {
      continue;
    }

    const text = sanitizeText(node.textContent || "").toLowerCase();
    const aria = sanitizeText(node.getAttribute("aria-label") || "").toLowerCase();
    const title = sanitizeText(node.getAttribute("title") || "").toLowerCase();
    const testId = sanitizeText(node.getAttribute("data-testid") || "").toLowerCase();
    const combined = `${text} ${aria} ${title} ${testId}`;

    if (!combined.includes("stop") && !combined.includes("cancel")) {
      continue;
    }
    if (/copy|regenerate|retry|edit|share|favorite|download/.test(combined)) {
      continue;
    }
    return true;
  }

  return false;
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
    if (event.source !== window) {
      return;
    }

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
    } else if (event.data?.type === "ZAI_BRIDGE_REQUEST_REWRITTEN") {
        const payload = event.data.payload || {};
        if (payload.endpoint && payload.modelId) {
          console.log(`[zai-bridge] ${payload.endpoint} request model=${payload.modelId}${payload.enableThinking === undefined ? "" : ` thinking=${payload.enableThinking}`}`);
        }
        const nextThinking = asBooleanOrUndefined(payload.enableThinking);
        if (nextThinking !== undefined) {
          modelState.enableThinking = nextThinking;
        }
    }
});

void ensureModelStateLoaded();

function startStreaming() {
  stopActiveStream();
  startSilentAudio();
  requestWakeLock();

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
      const seemsDone = !generating && streamState.hasNewContent && streamState.stableTicks >= 2;

      if (seemsDone && streamState.lastText) {
        emitStreamEvent(streamState.streamId, {
          type: "done",
          fullText: streamState.lastText,
        });
        stopActiveStream();
        return;
      }

      if (!generating && !streamState.hasNewContent && streamState.stableTicks >= 10) {
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

async function confirmPromptSubmission(composer, baseline) {
  for (let i = 0; i < 20; i++) {
    await wait(100);
    const apiStarted = lastApiStartAt > baseline.apiStart;
    const stopAppeared = !baseline.stopVisible && stopButtonVisible();
    const composerCleared = baseline.composerHadText && isComposerEmpty(composer);
    if (apiStarted || stopAppeared || composerCleared) {
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

function sendPromptResult() {
  return {
    submitted: true,
    selectedModelId: modelState.selectedModelId,
    selectedModelLabel: modelState.selectedModelLabel,
    enableThinking: modelState.enableThinking,
  };
}

async function runSendPrompt(params) {
  await ensureModelStateLoaded();
  startSilentAudio();
  requestWakeLock();

  const requestedModelId = toCleanString(params.modelId);
  if (requestedModelId) {
    modelState.selectedModelId = requestedModelId;
    const active = modelState.models.find((entry) => entry.id.toLowerCase() === requestedModelId.toLowerCase());
    modelState.selectedModelLabel = active?.name || modelState.selectedModelLabel || requestedModelId;
  }
  const requestedThinking = asBooleanOrUndefined(params.enableThinking);
  if (requestedThinking !== undefined) {
    modelState.enableThinking = requestedThinking;
  }
  postBridgePreferencesToPage();
  void persistModelState();
  if (modelState.selectedModelId) {
    console.log(
      `[zai-bridge] Using model ${modelState.selectedModelLabel || modelState.selectedModelId} (${modelState.selectedModelId}) for upcoming /api/v1/chats/new and /api/v2/chat/completions requests.`,
    );
  }
  
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
  await wait(150);
  if (isComposerEmpty(composer)) {
    throw new Error("Prompt text was not inserted into z.ai composer.");
  }

  // Try submit button first
  const submit = queryFirstVisible(SELECTORS.submit);
  if (submit && !submit.disabled) {
    const baseline = {
      apiStart: lastApiStartAt,
      stopVisible: stopButtonVisible(),
      composerHadText: !isComposerEmpty(composer),
    };
    submit.click();
    if (await confirmPromptSubmission(composer, baseline)) {
      return sendPromptResult();
    }
  }

  // If button is disabled or didn't respond, wait a bit and retry aggressively
  await wait(300);
  const retrySubmit = queryFirstVisible(SELECTORS.submit);
  if (retrySubmit && !retrySubmit.disabled) {
    const baseline = {
      apiStart: lastApiStartAt,
      stopVisible: stopButtonVisible(),
      composerHadText: !isComposerEmpty(composer),
    };
    retrySubmit.click();
    if (await confirmPromptSubmission(composer, baseline)) {
      return sendPromptResult();
    }
  }

  // Fallback: try Enter key with multiple events for robustness
  const enterEvent = {
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
  };
  
  composer.focus();
  composer.dispatchEvent(new KeyboardEvent("keydown", enterEvent));
  composer.dispatchEvent(new KeyboardEvent("keypress", enterEvent));
  composer.dispatchEvent(new KeyboardEvent("keyup", enterEvent));

  if (
    await confirmPromptSubmission(composer, {
      apiStart: lastApiStartAt,
      stopVisible: stopButtonVisible(),
      composerHadText: !isComposerEmpty(composer),
    })
  ) {
    return sendPromptResult();
  }

  // Final fallback: try form submission if applicable
  const form = composer.closest('form');
  if (form) {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    if (
      await confirmPromptSubmission(composer, {
        apiStart: lastApiStartAt,
        stopVisible: stopButtonVisible(),
        composerHadText: !isComposerEmpty(composer),
      })
    ) {
      return sendPromptResult();
    }
  }

  throw new Error("Prompt submit could not be confirmed in z.ai UI.");

}

async function runCheckReady() {
  await ensureModelStateLoaded();
  postBridgePreferencesToPage();
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
  const currentUrl = window.location.href;
  const isHome = currentUrl === "https://chat.z.ai/" || currentUrl === "https://chat.z.ai" || currentUrl.endsWith(".z.ai/");
  
  if (!isHome) {
    window.location.assign("https://chat.z.ai/");
    return {
      conversationId: undefined,
      navigating: true,
    };
  }

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

async function runListModelsFromUiScrape() {
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
    return [];
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
  
  return models.slice(0, 60);
}

async function runListModels() {
  await ensureModelStateLoaded();
  const discovered = await discoverModelsFromApi();

  if (discovered.models.length > 0) {
    modelState.models = discovered.models;
    if (discovered.defaultModelId) {
      modelState.defaultModelId = discovered.defaultModelId;
    }
    console.log(`[zai-bridge] Fetched ${modelState.models.length} models from /api/models.`);
  } else {
    const uiModels = await runListModelsFromUiScrape();
    modelState.models = dedupeModelOptions(
      uiModels.map((entry) => ({
        id: toCleanString(entry.id) || toCleanString(entry.label),
        name: toCleanString(entry.label) || toCleanString(entry.id),
        raw: entry,
      })),
    );
    console.warn("[zai-bridge] Falling back to UI model scrape because /api/models did not yield models.");
  }

  alignSelectedModelWithAvailableModels();
  postBridgePreferencesToPage();
  await persistModelState();

  if (!modelState.models.length) {
    return {
      models: [],
      selectedModelId: modelState.selectedModelId,
      defaultModelId: modelState.defaultModelId,
      source: discovered.source,
    };
  }

  const modelsForUi = formatModelOptionsForUi(modelState.models);
  const activeModel = modelState.models.find(
    (entry) => modelState.selectedModelId && entry.id.toLowerCase() === modelState.selectedModelId.toLowerCase(),
  );
  console.log(
    `[zai-bridge] Active model: ${activeModel?.name || modelState.selectedModelLabel || "none"} (${modelState.selectedModelId || "none"})`,
  );
  return {
    models: modelsForUi,
    selectedModelId: modelState.selectedModelId,
    defaultModelId: modelState.defaultModelId,
    source: discovered.source,
  };
}

async function runSelectModel(params) {
  await ensureModelStateLoaded();
  const targetRaw = toCleanString(params.modelId);
  if (!targetRaw) {
    return { ok: true };
  }

  if (!modelState.models.length) {
    await runListModels();
  }

  const target = targetRaw.toLowerCase();
  const matchingModel = modelState.models.find(
    (entry) => entry.id.toLowerCase() === target || entry.name.toLowerCase() === target,
  );

  if (matchingModel) {
    modelState.selectedModelId = matchingModel.id;
    modelState.selectedModelLabel = matchingModel.name;
  } else {
    const labelHint = toCleanString(params.modelLabel);
    modelState.selectedModelId = targetRaw;
    modelState.selectedModelLabel = labelHint || targetRaw;
    console.warn(`[zai-bridge] Selected model id "${targetRaw}" not found in discovered list; using it directly.`);
  }

  const requestedThinking = asBooleanOrUndefined(params.enableThinking);
  if (requestedThinking !== undefined) {
    modelState.enableThinking = requestedThinking;
  }

  postBridgePreferencesToPage();
  await persistModelState();

  let uiClicked = false;
  const picker = queryFirstVisible(SELECTORS.modelPicker);
  if (picker) {
    picker.click();
    await wait(200);
    for (const option of queryAll(SELECTORS.modelOption)) {
      const text = sanitizeText(option.getAttribute("data-value") || option.innerText || "").toLowerCase();
      if (
        text === modelState.selectedModelId.toLowerCase() ||
        text.includes(modelState.selectedModelId.toLowerCase()) ||
        (modelState.selectedModelLabel && text.includes(modelState.selectedModelLabel.toLowerCase()))
      ) {
        option.click();
        uiClicked = true;
        await wait(100);
        break;
      }
    }
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  }

  console.log(`[zai-bridge] Selected model ${modelState.selectedModelLabel} (${modelState.selectedModelId}), uiClicked=${uiClicked}`);
  return {
    ok: true,
    modelId: modelState.selectedModelId,
    modelLabel: modelState.selectedModelLabel,
    uiClicked,
  };
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
  await ensureModelStateLoaded();
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
