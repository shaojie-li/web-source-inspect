// Bridge for the isolated world.
//
// The probe must run in the MAIN world because the isolated world cannot read DOM
// __reactFiber$ expandos, while the MAIN world cannot access the chrome.* API.
// This script proxies configuration reads and writes via window.postMessage, whose
// cross-world structured cloning is more reliable than CustomEvent.detail.
//
// Use storage.local rather than sync: configured absolute disk paths would be wrong
// when synchronized across devices.

const MSG_NS = "source-inspect";
const DEFAULTS = { editor: "vscode", roots: {} };

/** Stores an origin-to-project-root map; only returns the entry for this origin. */
async function readConfigForThisOrigin() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  const roots = stored.roots || {};
  return {
    editor: stored.editor || DEFAULTS.editor,
    projectRoot: roots[location.origin] || "",
    origin: location.origin,
  };
}

async function handle(action, payload) {
  if (action === "get-config") return readConfigForThisOrigin();

  if (action === "set-editor") {
    await chrome.storage.local.set({ editor: payload.editor });
    return { ok: true };
  }

  if (action === "set-project-root") {
    const { roots = {} } = await chrome.storage.local.get({ roots: {} });
    if (payload.projectRoot) roots[location.origin] = payload.projectRoot;
    else delete roots[location.origin]; // An empty value clears this origin's configuration.
    await chrome.storage.local.set({ roots });
    return { ok: true };
  }

  throw new Error(`Unknown action: ${action}`);
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg || msg.ns !== MSG_NS || msg.dir !== "request") return;

  handle(msg.action, msg.payload || {}).then(
    (data) =>
      window.postMessage(
        { ns: MSG_NS, dir: "response", id: msg.id, data },
        location.origin,
      ),
    (err) =>
      window.postMessage(
        { ns: MSG_NS, dir: "response", id: msg.id, error: err.message },
        location.origin,
      ),
  );
});

// Push option-page changes to the MAIN world instead of waiting for its next request.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  readConfigForThisOrigin().then((config) => {
    window.postMessage(
      { ns: MSG_NS, dir: "push", action: "config-changed", data: config },
      location.origin,
    );
  });
});
