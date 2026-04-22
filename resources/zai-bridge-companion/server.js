const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.ZAI_BRIDGE_PORT || 17833);
const HOST = process.env.ZAI_BRIDGE_HOST || '127.0.0.1';

const wss = new WebSocketServer({
  host: HOST,
  port: PORT,
  path: '/ws',
});

let browserClient = null;
const vscodeClients = new Set();
const pending = new Map();
const streamOwners = new Map();

function now() {
  return Date.now();
}

function send(socket, payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  socket.send(JSON.stringify(payload));
  return true;
}

function respond(socket, id, ok, result, error) {
  send(socket, {
    kind: 'response',
    id,
    ok,
    result,
    error,
    timestamp: now(),
  });
}

function failPendingForSocket(socket, code, message) {
  for (const [id, item] of pending) {
    if (item.owner !== socket) {
      continue;
    }
    clearTimeout(item.timeout);
    pending.delete(id);
    respond(item.owner, id, false, undefined, { code, message, retriable: true });
  }
}

function failAllPending(code, message) {
  for (const [id, item] of pending) {
    clearTimeout(item.timeout);
    pending.delete(id);
    respond(item.owner, id, false, undefined, { code, message, retriable: true });
  }
}

function routeRequestToBrowser(owner, request) {
  const wantsOpenHome = Boolean(request && request.params && request.params.openHome);

  if (request.method === 'health' && !wantsOpenHome) {
    respond(owner, request.id, true, {
      companionReachable: true,
      browserConnected: Boolean(browserClient && browserClient.readyState === WebSocket.OPEN),
      ready: false,
      loginRequired: false,
    });
    return;
  }

  if (!browserClient || browserClient.readyState !== WebSocket.OPEN) {
    respond(owner, request.id, false, undefined, {
      code: 'BROWSER_NOT_CONNECTED',
      message: 'Browser extension is not connected to companion.',
      retriable: true,
    });
    return;
  }

  const timeout = setTimeout(() => {
    pending.delete(request.id);
    respond(owner, request.id, false, undefined, {
      code: 'TIMEOUT',
      message: `${request.method} timed out waiting for browser extension.`,
      retriable: true,
    });
  }, 30000);

  pending.set(request.id, {
    owner,
    method: request.method,
    timeout,
  });

  send(browserClient, request);
}

function handleVscodeMessage(socket, message) {
  if (message.kind !== 'request' || !message.id || !message.method) {
    return;
  }
  routeRequestToBrowser(socket, message);
}

function handleBrowserResponse(message) {
  if (message.kind !== 'response' || !message.id) {
    return;
  }
  const item = pending.get(message.id);
  if (!item) {
    return;
  }
  pending.delete(message.id);
  clearTimeout(item.timeout);
  respond(item.owner, message.id, Boolean(message.ok), message.result, message.error);

  if (item.method === 'streamStart' && message.ok && message.result && typeof message.result.streamId === 'string') {
    streamOwners.set(message.result.streamId, item.owner);
  }
}

function handleBrowserEvent(message) {
  if (message.kind !== 'event' || typeof message.streamId !== 'string') {
    return;
  }

  const owner = streamOwners.get(message.streamId);
  if (owner && owner.readyState === WebSocket.OPEN) {
    send(owner, message);
  } else {
    for (const client of vscodeClients) {
      send(client, message);
    }
  }

  if (message.event?.type === 'done' || message.event?.type === 'error') {
    streamOwners.delete(message.streamId);
  }
}

function handleSocketClose(socket) {
  if (socket === browserClient) {
    browserClient = null;
    failAllPending('DISCONNECTED', 'Browser extension disconnected.');
  }

  if (vscodeClients.has(socket)) {
    vscodeClients.delete(socket);
    failPendingForSocket(socket, 'DISCONNECTED', 'VS Code client disconnected.');
    for (const [streamId, owner] of streamOwners) {
      if (owner === socket) {
        streamOwners.delete(streamId);
      }
    }
  }
}

function parse(raw) {
  try {
    return JSON.parse(raw.toString());
  } catch {
    return null;
  }
}

wss.on('connection', (socket) => {
  console.log('[zai-bridge] New socket connection established.');
  socket.meta = { role: 'unknown' };

  socket.on('message', (raw) => {
    const message = parse(raw);
    if (!message) {
      return;
    }

    if (message.kind === 'hello') {
      console.log(`[zai-bridge] Handshake received: role=${message.role}, version=${message.version || 'unknown'}`);
      socket.meta.role = message.role;
      if (message.role === 'browser') {
        if (browserClient && browserClient !== socket) {
          console.log('[zai-bridge] Replacing existing browser client.');
          browserClient.close();
        }
        browserClient = socket;
      }
      if (message.role === 'vscode') {
        vscodeClients.add(socket);
      }
      return;
    }

    if (socket.meta.role === 'vscode') {
      handleVscodeMessage(socket, message);
      return;
    }

    if (socket.meta.role === 'browser') {
      handleBrowserResponse(message);
      handleBrowserEvent(message);
    }
  });

  socket.on('close', () => {
    handleSocketClose(socket);
  });

  socket.on('error', () => {
    // Close will handle cleanup.
  });
});

const pingInterval = setInterval(() => {
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.ping();
      } catch {
        // Ignore ping failures.
      }
    }
  }
}, 15000);

wss.on('listening', () => {
  console.log(`[zai-bridge] Companion listening on ws://${HOST}:${PORT}/ws`);
});

wss.on('error', (error) => {
  if (error && error.code === 'EADDRINUSE') {
    console.error(`[zai-bridge] Port ${PORT} already in use on ${HOST}.`);
    console.error('[zai-bridge] Another companion instance may already be running.');
    process.exit(1);
    return;
  }
  console.error(`[zai-bridge] Server error: ${error && error.message ? error.message : String(error)}`);
});

function shutdown() {
  clearInterval(pingInterval);
  try {
    wss.close();
  } catch {
    // Ignore close errors during shutdown.
  }
}

process.on('SIGINT', () => {
  shutdown();
  process.exit(0);
});

process.on('SIGTERM', () => {
  shutdown();
  process.exit(0);
});
