const DEFAULTS = { enabled: true, showCache: false };

function load() {
  chrome.storage.local.get(DEFAULTS, (prefs) => {
    document.getElementById("enabled").checked = prefs.enabled !== false;
    document.getElementById("showCache").checked = !!prefs.showCache;
  });
}

function bind() {
  document.getElementById("enabled").addEventListener("change", (e) => {
    chrome.storage.local.set({ enabled: !!e.target.checked });
  });
  document.getElementById("showCache").addEventListener("change", (e) => {
    chrome.storage.local.set({ showCache: !!e.target.checked });
  });
}

document.addEventListener("DOMContentLoaded", () => {
  load();
  bind();
});
