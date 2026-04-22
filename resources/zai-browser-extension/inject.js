// inject.js
// Runs in MAIN world. Intercepts fetch for:
// - model payload injection into real z.ai API calls
// - SSE streaming capture for chat completions

Object.defineProperty(document, "visibilityState", { get: () => "visible", configurable: true });
Object.defineProperty(document, "hidden", { get: () => false, configurable: true });
Object.defineProperty(document, "webkitVisibilityState", { get: () => "visible", configurable: true });
Object.defineProperty(document, "webkitHidden", { get: () => false, configurable: true });
document.hasFocus = () => true;

const blockEvent = (event) => {
  event.stopImmediatePropagation();
  event.preventDefault();
};

window.addEventListener("visibilitychange", blockEvent, true);
window.addEventListener("webkitvisibilitychange", blockEvent, true);
window.addEventListener("blur", blockEvent, true);
window.addEventListener("focusout", blockEvent, true);

const originalFetch = window.fetch;
const bridgePreferences = {
  modelId: undefined,
  modelLabel: undefined,
  enableThinking: undefined,
};
const ALLOWED_JSON_FETCH_URLS = new Set([
  "https://chat.z.ai/api/models",
  "https://chat.z.ai/api/config",
]);

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
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

window.addEventListener("message", (event) => {
  if (event.source !== window) {
    return;
  }
  const data = event.data;
  if (!data || typeof data !== "object") {
    return;
  }

  if (data.type === "ZAI_BRIDGE_FETCH_JSON_REQUEST") {
    const requestId = cleanString(data.requestId);
    const url = cleanString(data.url);
    if (!requestId || !url) {
      return;
    }

    if (!ALLOWED_JSON_FETCH_URLS.has(url)) {
      window.postMessage(
        {
          type: "ZAI_BRIDGE_FETCH_JSON_RESPONSE",
          requestId,
          ok: false,
          error: `URL not allowed: ${url}`,
        },
        "*",
      );
      return;
    }

    void (async () => {
      try {
        const response = await originalFetch(url, {
          method: "GET",
          credentials: "include",
          headers: {
            accept: "application/json, text/plain, */*",
          },
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} for ${url}`);
        }
        const result = await response.json();
        window.postMessage(
          {
            type: "ZAI_BRIDGE_FETCH_JSON_RESPONSE",
            requestId,
            ok: true,
            result,
          },
          "*",
        );
      } catch (error) {
        window.postMessage(
          {
            type: "ZAI_BRIDGE_FETCH_JSON_RESPONSE",
            requestId,
            ok: false,
            error: String(error),
          },
          "*",
        );
      }
    })();
    return;
  }

  if (data.type !== "ZAI_BRIDGE_SET_PREFERENCES") {
    return;
  }

  const payload = data.payload || {};
  bridgePreferences.modelId = cleanString(payload.modelId) || undefined;
  bridgePreferences.modelLabel = cleanString(payload.modelLabel) || undefined;
  const nextThinking = asBooleanOrUndefined(payload.enableThinking);
  if (nextThinking !== undefined) {
    bridgePreferences.enableThinking = nextThinking;
  }

  if (bridgePreferences.modelId) {
    console.log(
      `[zai-bridge] Preference sync model=${bridgePreferences.modelLabel || bridgePreferences.modelId} (${bridgePreferences.modelId}) thinking=${bridgePreferences.enableThinking}`,
    );
  }
});

function getUrlFromFetchArgs(args) {
  const input = args[0];
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if (input && typeof input === "object" && typeof input.url === "string") {
    return input.url;
  }
  return "";
}

function mergeHeaders(baseHeaders, extraHeaders) {
  const merged = new Headers(baseHeaders || {});
  const extras = new Headers(extraHeaders || {});
  extras.forEach((value, key) => merged.set(key, value));
  return merged;
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function resolveEndpointKind(url) {
  if (!url) {
    return undefined;
  }
  if (url.includes("/api/v1/chats/new")) {
    return "new_chat";
  }
  if (url.includes("/api/v2/chat/completions")) {
    return "completion";
  }
  return undefined;
}

function normalizeThinkingFromPayload(kind, payload) {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  if (kind === "new_chat") {
    return asBooleanOrUndefined(payload?.chat?.enable_thinking);
  }
  if (kind === "completion") {
    return asBooleanOrUndefined(payload?.features?.enable_thinking);
  }
  return undefined;
}

function applyModelToNewChatPayload(payload, modelId, enableThinking) {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  if (!payload.chat || typeof payload.chat !== "object") {
    payload.chat = {};
  }

  let changed = false;
  if (modelId) {
    payload.chat.models = [modelId];
    changed = true;
  }

  if (enableThinking !== undefined) {
    payload.chat.enable_thinking = enableThinking;
    changed = true;
  }

  const messages = payload?.chat?.history?.messages;
  if (messages && typeof messages === "object") {
    for (const message of Object.values(messages)) {
      if (!message || typeof message !== "object") {
        continue;
      }
      if (modelId) {
        message.models = [modelId];
        changed = true;
      }
      if (enableThinking !== undefined) {
        if (!message.features || typeof message.features !== "object") {
          message.features = {};
        }
        message.features.enable_thinking = enableThinking;
      }
    }
  }

  return changed;
}

function applyModelToCompletionPayload(payload, modelId, enableThinking) {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  let changed = false;
  if (modelId) {
    payload.model = modelId;
    changed = true;
  }

  if (!payload.features || typeof payload.features !== "object") {
    payload.features = {};
  }
  if (enableThinking !== undefined) {
    payload.features.enable_thinking = enableThinking;
    changed = true;
  }

  return changed;
}

function buildRewrittenRequest(args, requestUrl, nextBody, initHeaders) {
  const input = args[0];
  const init = args[1] && typeof args[1] === "object" ? { ...args[1] } : {};

  if (input instanceof Request) {
    const headers = mergeHeaders(input.headers, initHeaders || init.headers);
    headers.set("content-type", "application/json");
    const nextRequest = new Request(input, {
      body: nextBody,
      headers,
      method: init.method || input.method,
      signal: init.signal || input.signal,
      credentials: init.credentials || input.credentials,
      mode: init.mode || input.mode,
      cache: init.cache || input.cache,
      redirect: init.redirect || input.redirect,
      referrer: init.referrer || input.referrer,
      referrerPolicy: init.referrerPolicy || input.referrerPolicy,
      integrity: init.integrity || input.integrity,
      keepalive: init.keepalive ?? input.keepalive,
    });
    args[0] = nextRequest;
    if (args.length > 1) {
      args[1] = undefined;
    }
    return;
  }

  const headers = mergeHeaders(init.headers, initHeaders);
  headers.set("content-type", "application/json");
  init.headers = headers;
  init.body = nextBody;
  if (!init.method) {
    init.method = "POST";
  }
  if (!args.length) {
    args.push(requestUrl);
  }
  if (args.length === 1) {
    args.push(init);
  } else {
    args[1] = init;
  }
}

async function maybeRewriteModelPayload(args, url) {
  const kind = resolveEndpointKind(url);
  if (!kind) {
    return;
  }

  const input = args[0];
  const init = args[1] && typeof args[1] === "object" ? args[1] : {};
  const method = cleanString((init && init.method) || (input instanceof Request ? input.method : "GET")).toUpperCase() || "GET";
  if (method !== "POST") {
    return;
  }

  let bodyText = "";
  if (typeof init.body === "string") {
    bodyText = init.body;
  } else if (input instanceof Request) {
    bodyText = await input.clone().text().catch(() => "");
  }

  if (!bodyText) {
    return;
  }

  const payload = tryParseJson(bodyText);
  if (!payload || typeof payload !== "object") {
    return;
  }

  const observedThinking = normalizeThinkingFromPayload(kind, payload);
  if (observedThinking !== undefined && bridgePreferences.enableThinking === undefined) {
    bridgePreferences.enableThinking = observedThinking;
  }

  const selectedModelId = bridgePreferences.modelId;
  const selectedThinking = bridgePreferences.enableThinking;

  let changed = false;
  if (kind === "new_chat") {
    changed = applyModelToNewChatPayload(payload, selectedModelId, selectedThinking);
  } else if (kind === "completion") {
    changed = applyModelToCompletionPayload(payload, selectedModelId, selectedThinking);
  }

  if (!changed) {
    return;
  }

  const rewrittenBody = JSON.stringify(payload);
  buildRewrittenRequest(args, url, rewrittenBody, init.headers);

  const endpointLabel = kind === "new_chat" ? "/api/v1/chats/new" : "/api/v2/chat/completions";
  console.log(
    `[zai-bridge] Applied model override on ${endpointLabel}: model=${selectedModelId || "unchanged"} thinking=${selectedThinking}`,
  );
  window.postMessage(
    {
      type: "ZAI_BRIDGE_REQUEST_REWRITTEN",
      payload: {
        endpoint: endpointLabel,
        modelId: selectedModelId,
        enableThinking: selectedThinking,
      },
    },
    "*",
  );
}

window.fetch = async function (...args) {
  const url = getUrlFromFetchArgs(args);
  const kind = resolveEndpointKind(url);

  if (kind) {
    try {
      await maybeRewriteModelPayload(args, url);
    } catch (error) {
      console.warn("[zai-bridge] Request rewrite failed, continuing without rewrite:", error);
    }
  }

  const response = await originalFetch.apply(this, args);
  if (kind === "completion") {
    const clonedResponse = response.clone();
    void readStream(clonedResponse.body);
  }
  return response;
};

async function readStream(body) {
  if (!body) {
    return;
  }

  window.postMessage({ type: "ZAI_API_START" }, "*");

  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    let done;
    let value;
    try {
      const result = await reader.read();
      done = result.done;
      value = result.value;
    } catch (error) {
      window.postMessage({ type: "ZAI_API_ERROR", message: String(error) }, "*");
      break;
    }

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) {
        continue;
      }

      const dataStr = trimmed.slice(6).trim();
      if (dataStr === "[DONE]") {
        continue;
      }

      const parsed = tryParseJson(dataStr);
      if (parsed) {
        window.postMessage({ type: "ZAI_API_CHUNK", data: parsed }, "*");
      }
    }
  }

  window.postMessage({ type: "ZAI_API_DONE" }, "*");
}
