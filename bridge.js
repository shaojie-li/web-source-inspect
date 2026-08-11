// isolated world 的桥。
//
// 为什么需要它：探针必须跑在 MAIN world（isolated world 读不到 DOM 节点上的 __reactFiber$
// expando），但 MAIN world 拿不到 chrome.* API。所以配置的读写由这个脚本代理，
// 两边用 window.postMessage 通信（跨 world 有结构化克隆，比 CustomEvent.detail 可靠）。
//
// 用 storage.local 而不是 sync：配的是磁盘绝对路径，跨设备同步只会带来错的路径。

const MSG_NS = "source-inspect";
const DEFAULTS = { editor: "vscode", roots: {} };

/** 存的是 origin → 项目根 的映射；返回给页面时只挑当前 origin 那一条 */
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
    else delete roots[location.origin]; // 传空值表示清除本 origin 的配置
    await chrome.storage.local.set({ roots });
    return { ok: true };
  }

  throw new Error(`未知的 action: ${action}`);
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

// options 页改了配置就主动推给 MAIN world，不用等下次请求
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  readConfigForThisOrigin().then((config) => {
    window.postMessage(
      { ns: MSG_NS, dir: "push", action: "config-changed", data: config },
      location.origin,
    );
  });
});
