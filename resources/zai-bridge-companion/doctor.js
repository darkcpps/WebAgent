const WebSocket = require('ws');

const url = process.env.ZAI_BRIDGE_URL || 'ws://127.0.0.1:17833/ws';
const timeoutMs = Number(process.env.ZAI_BRIDGE_TIMEOUT_MS || 3000);

const socket = new WebSocket(url);
let done = false;

function finish(code, message) {
  if (done) {
    return;
  }
  done = true;
  if (message) {
    console.log(message);
  }
  try {
    socket.close();
  } catch {
    // ignore
  }
  process.exit(code);
}

const timeout = setTimeout(() => {
  finish(1, `[zai-bridge] FAIL timeout connecting to ${url}`);
}, timeoutMs);

socket.on('open', () => {
  clearTimeout(timeout);
  finish(0, `[zai-bridge] OK connected to ${url}`);
});

socket.on('error', (error) => {
  clearTimeout(timeout);
  finish(1, `[zai-bridge] FAIL ${error && error.message ? error.message : String(error)}`);
});

