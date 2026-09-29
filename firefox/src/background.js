/**
 * Shiphook Claude Meter — background (MV3 service worker / Firefox event page).
 * Seeds default prefs on install. No network, no message handling: the content
 * script talks to chrome.storage directly, so this worker stays asleep.
 */

const DEFAULT_PREFS = {
  enabled: true,
  showCache: false,
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(Object.keys(DEFAULT_PREFS), (cur) => {
    const patch = {};
    for (const [k, v] of Object.entries(DEFAULT_PREFS)) {
      if (cur[k] === undefined) patch[k] = v;
    }
    if (Object.keys(patch).length) chrome.storage.local.set(patch);
  });
  // Written on every update by <=0.1.14 and never read.
  chrome.storage.local.remove('shiphook_claude_meter');
});
