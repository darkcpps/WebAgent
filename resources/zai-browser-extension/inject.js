// inject.js
// This script runs in the MAIN world to intercept fetch responses natively and spoof visibility.

// 1. Visibility & Focus Spoofing
// Tricking the page into thinking it is always active and visible to prevent background throttling.
Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
Object.defineProperty(document, 'webkitVisibilityState', { get: () => 'visible', configurable: true });
Object.defineProperty(document, 'webkitHidden', { get: () => false, configurable: true });

// Ensure focus remains "locked"
document.hasFocus = () => true;

// Prevent the page from knowing it lost focus or visibility changed
const blockEvent = (e) => {
    e.stopImmediatePropagation();
    e.preventDefault();
};

window.addEventListener('visibilitychange', blockEvent, true);
window.addEventListener('webkitvisibilitychange', blockEvent, true);
window.addEventListener('blur', blockEvent, true);
window.addEventListener('focusout', blockEvent, true);

// 2. Fetch Interception
const originalFetch = window.fetch;

window.fetch = async function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;

    const isCompletion = url && url.includes('/api/v2/chat/completions');

    if (!isCompletion) {
        return originalFetch.apply(this, args);
    }

    try {
        const response = await originalFetch.apply(this, args);
        // Clone the response so the page can still consume its own stream!
        const clonedResponse = response.clone();

        // Process asynchronously without blocking original execution
        readStream(clonedResponse.body);

        return response;
    } catch (err) {
        return originalFetch.apply(this, args);
    }
};

async function readStream(body) {
    if (!body) return;

    window.postMessage({ type: 'ZAI_API_START' }, '*');

    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
        let done, value;
        try {
            const result = await reader.read();
            done = result.done;
            value = result.value;
        } catch (err) {
            window.postMessage({ type: 'ZAI_API_ERROR', message: err.toString() }, '*');
            break;
        }

        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        
        // Z.ai streams using SSE (Server-Sent Events) formatting
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep the last (incomplete) segment in buffer

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('data: ')) {
                const dataStr = trimmed.slice(6).trim();
                
                if (dataStr === '[DONE]') {
                    continue;
                }
                
                try {
                    const parsed = JSON.parse(dataStr);
                    window.postMessage({ type: 'ZAI_API_CHUNK', data: parsed }, '*');
                } catch (e) {
                    // Ignore unparseable lines (e.g. heartbeat)
                }
            }
        }
    }

    window.postMessage({ type: 'ZAI_API_DONE' }, '*');
}
