const COMPANION_URL_127 = "ws://127.0.0.1:17833/ws";
const COMPANION_URL_LOCAL = "ws://localhost:17833/ws";
const ZAI_PATTERN = "https://chat.z.ai/*";

let socket = null;
let currentUrl = COMPANION_URL_127;

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  console.log(`[zai-bridge] Connecting to companion at ${currentUrl}...`);
  socket = new WebSocket(currentUrl);

  socket.addEventListener("open", () => {
    console.log("[zai-bridge] Socket open. Sending hello...");
    send({
      kind: "hello",
      role: "browser",
      version: chrome.runtime.getManifest().version,
      timestamp: Date.now(),
    });
  });

  socket.addEventListener("message", async (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    if (message.kind !== "request" || !message.id || !message.method) {
      return;
    }

    console.log(`[zai-bridge] Request: ${message.method}`, message.params);
    try {
      const result = await handleRequest(message.method, message.params || {});
      send({
        kind: "response",
        id: message.id,
        ok: true,
        result,
        timestamp: Date.now(),
      });
    } catch (error) {
      console.error(`[zai-bridge] ${message.method} failed:`, error);
      send({
        kind: "response",
        id: message.id,
        ok: false,
        error: {
          code: "INTERNAL",
          message: error instanceof Error ? error.message : String(error),
          retriable: true,
        },
        timestamp: Date.now(),
      });
    }
  });

  socket.addEventListener("close", () => {
    console.warn("[zai-bridge] Socket closed.");
    // Swap URLs on failure to try both localhost and 127.0.0.1
    currentUrl = currentUrl === COMPANION_URL_127 ? COMPANION_URL_LOCAL : COMPANION_URL_127;
  });

  socket.addEventListener("error", (err) => {
    console.error("[zai-bridge] Socket error:", err);
  });
}

// Keep-alive for Service Worker
chrome.alarms.create("keep-alive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keep-alive") {
    connect();
  }
});

function send(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  socket.send(JSON.stringify(payload));
  return true;
}

async function queryZaiTabs() {
  return chrome.tabs.query({ url: ZAI_PATTERN });
}

async function ensureZaiTab({ createIfMissing = false, openHome = false, focus = false } = {}) {
  let tabs = await queryZaiTabs();
  if (!tabs.length && createIfMissing) {
    const created = await chrome.tabs.create({ url: "https://chat.z.ai/", active: focus });
    tabs = created ? [created] : [];
  }

  const tab = tabs.find((candidate) => candidate.id != null) || null;
  if (!tab || tab.id == null) {
    throw new Error("No z.ai tab is available.");
  }

  if (openHome) {
    await chrome.tabs.update(tab.id, { url: "https://chat.z.ai/", active: focus });
  } else if (focus) {
    await chrome.tabs.update(tab.id, { active: true });
  }

  return tab.id;
}

async function sendToContent(method, params = {}) {
  try {
    const openHome = method === "health" && Boolean(params && params.openHome);
    const tabId = await ensureZaiTab({ createIfMissing: true, openHome, focus: openHome });
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "zai-bridge",
      method,
      params,
    });
    if (response && response.error) {
      throw new Error(response.error);
    }
    return response;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("back/forward cache") || msg.includes("message channel closed") || msg.includes("Receiving end does not exist")) {
      console.warn("[zai-bridge] Hard connection failure, forcing tab reload for recovery...", msg);
      
      const tabId = await ensureZaiTab({ createIfMissing: true });
      // Force reload to re-inject content script
      await chrome.tabs.reload(tabId);
      
      // Wait for content script to be ready (up to 5 seconds)
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 500));
        try {
          const health = await chrome.tabs.sendMessage(tabId, { type: "zai-bridge", method: "health" });
          if (health && health.browserConnected) {
            console.log("[zai-bridge] Recovery successful, retrying original request.");
            return chrome.tabs.sendMessage(tabId, {
              type: "zai-bridge",
              method,
              params,
            });
          }
        } catch {
          // Still loading...
        }
      }
      throw new Error("[bridge] Failed to recover z.ai connection after tab reload.");
    }
    throw error;
  }
}

async function handleRequest(method, params) {
  if (method === "health") {
    try {
      return await sendToContent("health", params);
    } catch {
      return { browserConnected: true, ready: false, loginRequired: false };
    }
  }

  return sendToContent(method, params);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "zai-bridge-event") {
    return false;
  }

  send({
    kind: "event",
    streamId: message.streamId,
    event: message.event,
    timestamp: Date.now(),
  });
  sendResponse({ ok: true });
  return true;
});

// Initial connect
connect();
