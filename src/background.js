/**
 * Shiphook Claude Meter — background service worker (MV3).
 * Storage helpers only; no network.
 */

const STORAGE_KEY = 'shiphook_claude_meter';

const DEFAULT_PREFS = {
  enabled: true,
  showCache: false,
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(DEFAULT_PREFS, (cur) => {
    const patch = {};
    if (cur.enabled === undefined) patch.enabled = true;
    if (cur.showCache === undefined) patch.showCache = false;
    if (Object.keys(patch).length) chrome.storage.local.set(patch);
  });
});

/**
 * @param {object} patch
 * @returns {Promise<object>}
 */
async function mergeLocal(patch) {
  const existing = await getLocal();
  const next = { ...existing, ...patch, updatedAt: Date.now() };
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}

/**
 * @returns {Promise<object>}
 */
async function getLocal() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] || {};
}

/**
 * @returns {Promise<void>}
 */
async function clearLocal() {
  await chrome.storage.local.remove(STORAGE_KEY);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.source !== 'shiphook-claude-meter') {
    return false;
  }

  (async () => {
    try {
      switch (message.type) {
        case 'storage.get': {
          const data = await getLocal();
          sendResponse({ ok: true, data });
          break;
        }
        case 'storage.set': {
          const data = await mergeLocal(message.patch || {});
          sendResponse({ ok: true, data });
          break;
        }
        case 'storage.clear': {
          await clearLocal();
          sendResponse({ ok: true });
          break;
        }
        case 'prefs.get': {
          const prefs = await chrome.storage.local.get(DEFAULT_PREFS);
          sendResponse({
            ok: true,
            data: {
              enabled: prefs.enabled !== false,
              showCache: prefs.showCache === true,
            },
          });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'unknown_type' });
      }
    } catch (err) {
      sendResponse({
        ok: false,
        error: err && err.message ? err.message : String(err),
      });
    }
  })();

  return true; // async sendResponse
});
