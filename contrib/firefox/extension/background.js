'use strict';
// Answers the ozwell-computer server's requests (src/browser/bridge.ts), which arrive
// through the native messaging host Firefox starts for us (src/browser/native-host.ts).
// Requests are {id, method, params}; replies are {id, result} or {id, error}.

const METHODS = {
  'browser.info': () => browser.runtime.getBrowserInfo(),
  'cookies.getAll': (p) => browser.cookies.getAll(p),
  'cookies.set': (p) => browser.cookies.set(p),
  'cookies.remove': (p) => browser.cookies.remove(p),
};

const MIN_RETRY_MS = 1000;
const MAX_RETRY_MS = 30000;
let retryMs = MIN_RETRY_MS;

function connect() {
  const port = browser.runtime.connectNative('ozwell_computer');
  port.onMessage.addListener(async ({ id, method, params }) => {
    retryMs = MIN_RETRY_MS;
    try {
      const fn = METHODS[method];
      if (!fn) throw new Error(`unknown method ${method}`);
      port.postMessage({ id, result: (await fn(params || {})) ?? null });
    } catch (e) {
      // Firefox's cookie errors end with the cookie as JSON, value and all: leave it out.
      port.postMessage({ id, error: String((e && e.message) || e).replace(/\s*\{.*\}\s*$/s, '') });
    }
  });
  // The host exits only if it fails; it keeps retrying the server itself.
  port.onDisconnect.addListener(() => {
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
  });
}

connect();
