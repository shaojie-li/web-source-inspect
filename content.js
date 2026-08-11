// 可行性探针：只回答一个问题 —— 从一个 DOM 节点出发，React 到底愿意告诉我们多少源码信息。
// 不做 sourcemap，不做编辑器跳转。Alt+hover 高亮，Alt+click 探测并打印。
//
// 已验证的两条路径（见 README）：
//   React <=18: fiber._debugSource 直接给出 file:line:col，不需要 sourcemap
//   React 19  : _debugSource 被移除，改用 fiber._debugStack（一个 Error），
//               栈里第一个「用户代码帧」就是创建该元素的 JSX 调用点（bundle 位置），需 sourcemap 还原

// ---------- 配置：编辑器 + 项目根 ----------
// 真实存储在 chrome.storage.local，由 isolated world 的 bridge.js 代理 —— MAIN world 拿不到
// chrome.* API，而探针又必须待在 MAIN world（isolated world 读不到 DOM 上的 __reactFiber$）。
// 这里保留一份内存缓存，让 getEditor / getConfiguredRoot 能同步读：它们在 hover 热路径上。
// bridge 不可用时（没装 bridge.js、storage 出错）退回页面 localStorage，功能不至于全丢。

const MSG_NS = "source-inspect";
const LS_EDITOR_KEY = "__source_inspect_editor";
const LS_ROOT_KEY = "__source_inspect_project_root";
const DEFAULT_EDITOR = "vscode";
const EDITORS = [
  { id: "vscode", label: "VS Code", scheme: "vscode" },
  { id: "cursor", label: "Cursor", scheme: "cursor" },
];

const config = {
  editor: DEFAULT_EDITOR,
  projectRoot: "",
  store: "localStorage",
};

function lsRead(key) {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return ""; // 某些页面禁用了 localStorage
  }
}

function lsWrite(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch (e) {
    console.warn("[source-inspect] 写 localStorage 失败:", e.message);
  }
}

// 先吃 localStorage 里的值，让功能在 bridge 应答前就可用（也兼容早期版本存的数据）
config.editor = lsRead(LS_EDITOR_KEY) || DEFAULT_EDITOR;
config.projectRoot = lsRead(LS_ROOT_KEY);

let requestSeq = 0;
const pendingRequests = new Map();

function applyConfig(data, store) {
  if (
    typeof data.editor === "string" &&
    EDITORS.some((e) => e.id === data.editor)
  )
    config.editor = data.editor;
  if (typeof data.projectRoot === "string")
    config.projectRoot = data.projectRoot;
  config.store = store;
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg || msg.ns !== MSG_NS) return;

  if (msg.dir === "response") {
    const entry = pendingRequests.get(msg.id);
    if (!entry) return;
    pendingRequests.delete(msg.id);
    clearTimeout(entry.timer);
    entry.resolve(msg.error ? null : msg.data);
    return;
  }

  // options 页改了配置，bridge 主动推过来；卡片开着就就地重算一次
  if (msg.dir === "push" && msg.action === "config-changed" && msg.data) {
    applyConfig(msg.data, "chrome.storage");
    if (lastCard && card.style.display !== "none")
      showCard(lastCard.dom, lastCard.result);
  }
});

function askBridge(action, payload, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const id = ++requestSeq;
    const timer = setTimeout(() => {
      if (pendingRequests.delete(id)) resolve(null); // bridge.js 没装或没响应
    }, timeoutMs);
    pendingRequests.set(id, { resolve, timer });
    window.postMessage(
      { ns: MSG_NS, dir: "request", id, action, payload },
      location.origin,
    );
  });
}

askBridge("get-config").then((data) => {
  if (!data) {
    console.warn(
      "[source-inspect] bridge.js 未响应，配置退回页面 localStorage（重装插件可恢复）",
    );
    return;
  }
  applyConfig(data, "chrome.storage");
});

function getEditor() {
  return (
    EDITORS.find((e) => e.id === config.editor) ||
    EDITORS.find((e) => e.id === DEFAULT_EDITOR)
  );
}

function getConfiguredRoot() {
  return config.projectRoot || null;
}

/** 两处都写：chrome.storage 是正本（跨 origin 可用），localStorage 是 bridge 挂掉时的兜底 */
function setEditor(id) {
  config.editor = id;
  lsWrite(LS_EDITOR_KEY, id);
  askBridge("set-editor", { editor: id });
}

function setProjectRoot(root) {
  config.projectRoot = root;
  lsWrite(LS_ROOT_KEY, root);
  askBridge("set-project-root", { projectRoot: root });
}

const FIBER_KEYS = ["__reactFiber$", "__reactInternalInstance$"];
const PROPS_KEYS = ["__reactProps$", "__reactEventHandlers$"];

/** 找到 DOM 节点上 React 挂的 fiber。找不到说明这个节点不由 React 渲染（或是 production build）。 */
function findFiber(dom) {
  for (const key in dom) {
    for (const prefix of FIBER_KEYS) {
      if (key.startsWith(prefix)) return { fiber: dom[key], key };
    }
  }
  return { fiber: null, key: null };
}

/**
 * 点击目标可能是原生 DOM（innerHTML 插入、第三方库、Portal 内容），身上没有 fiber。
 * 这时不该直接失败 —— 往上找最近的 React 祖先，定位到"渲染它的容器"仍然有用。
 */
function findFiberFromDomOrAncestor(dom) {
  let node = dom;
  let hops = 0;
  while (node) {
    const { fiber, key } = findFiber(node);
    if (fiber) return { fiber, key, node, hops };
    node = node.parentElement;
    hops++;
  }
  return { fiber: null, key: null, node: null, hops: 0 };
}

function findProps(dom) {
  for (const key in dom) {
    for (const prefix of PROPS_KEYS) {
      if (key.startsWith(prefix)) return dom[key];
    }
  }
  return null;
}

/** fiber.type 可能是字符串（'div'）、函数组件、class、或 memo/forwardRef 包装对象 */
function typeName(type) {
  if (!type) return null;
  if (typeof type === "string") return type;
  if (typeof type === "function")
    return type.displayName || type.name || "(anonymous fn)";
  if (typeof type === "object") {
    if (type.displayName) return type.displayName;
    if (type.render) return `forwardRef(${typeName(type.render)})`;
    if (type.type) return `memo(${typeName(type.type)})`;
  }
  return String(type);
}

// ---------- React 19：从 _debugStack 里挖出 JSX 调用点 ----------

const FRAME_RE = /at\s+(?:async\s+)?(?:(.+?)\s+\()?(\S+?):(\d+):(\d+)\)?$/;

/** 框架自身的帧不是我们要的目标，跳过 */
function isFrameworkFrame(url) {
  return /\/node_modules\/|jsx-dev-runtime|react-dom|\breact\.development\b|\/@react-refresh|\/@vite\/|esm\.sh/.test(
    url,
  );
}

function parseDebugStack(fiber) {
  const err = fiber._debugStack;
  if (!err) return null;
  const raw = typeof err === "string" ? err : err.stack;
  if (!raw) return null;

  const frames = [];
  for (const line of raw.split("\n")) {
    const m = FRAME_RE.exec(line.trim());
    if (!m) continue;
    frames.push({
      fn: m[1] || "(anonymous)",
      url: m[2],
      line: +m[3],
      column: +m[4],
    });
  }
  // 第一个非框架帧 = 写下这个 JSX 元素的那一行（在编译产物中的位置）
  const jsxCallSite = frames.find((f) => !isFrameworkFrame(f.url)) || null;
  return { jsxCallSite, allFrames: frames };
}

/** 沿 fiber.return 向上走，记录每一层能拿到什么 */
function walkUp(startFiber, limit = 30) {
  const chain = [];
  let fiber = startFiber;
  while (fiber && chain.length < limit) {
    const stack = parseDebugStack(fiber);
    chain.push({
      tag: fiber.tag,
      name: typeName(fiber.type),
      // React <=18 路径
      debugSource: fiber._debugSource
        ? {
            fileName: fiber._debugSource.fileName,
            line: fiber._debugSource.lineNumber,
            column: fiber._debugSource.columnNumber ?? null,
          }
        : null,
      // React 19 路径
      jsxCallSite: stack ? stack.jsxCallSite : null,
      stackFrames: stack ? stack.allFrames : null,
      debugOwner: fiber._debugOwner ? typeName(fiber._debugOwner.type) : null,
      debugFields: Object.keys(fiber).filter((k) => k.startsWith("_debug")),
    });
    fiber = fiber.return;
  }
  return chain;
}

// React WorkTag 里属于"组件"的那几种：函数 / class / forwardRef / memo / 简单 memo。
// 不能用"名字首字母大写"来判断 —— forwardRef(X)、memo(X) 这类包装名是小写开头会被漏掉，
// 而 Fragment / Suspense / Provider 的 type 是 symbol，按名字判断又会漏进来。
const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15]);

function detectReactVersion() {
  const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (hook && hook.renderers) {
    for (const renderer of hook.renderers.values()) {
      if (renderer.version) return `${renderer.version} (via devtools hook)`;
    }
  }
  if (window.React && window.React.version)
    return `${window.React.version} (via window.React)`;
  return null;
}

// ---------- sourcemap 还原：bundle 位置 → 源码行列 ----------
// 纯 JS 手写 VLQ 解码，不引依赖，MV3 下无 wasm/CSP 问题。

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_IDX = {};
for (let i = 0; i < B64.length; i++) B64_IDX[B64[i]] = i;

function decodeVLQ(str) {
  const out = [];
  let shift = 0;
  let value = 0;
  for (const c of str) {
    const d = B64_IDX[c];
    const hasContinuation = d & 32;
    value += (d & 31) << shift;
    if (hasContinuation) {
      shift += 5;
      continue;
    }
    const negative = value & 1;
    value >>= 1;
    out.push(negative ? -value : value);
    shift = 0;
    value = 0;
  }
  return out;
}

/** mappings 字符串 → 按 generated 行分组的 segment 列表（全部 0-based） */
function parseMappings(mappings) {
  const lines = [];
  let srcIdx = 0;
  let srcLine = 0;
  let srcCol = 0;
  for (const lineStr of mappings.split(";")) {
    let genCol = 0;
    const segs = [];
    if (lineStr) {
      for (const segStr of lineStr.split(",")) {
        const f = decodeVLQ(segStr);
        genCol += f[0];
        const seg = { genCol };
        if (f.length >= 4) {
          srcIdx += f[1];
          srcLine += f[2];
          srcCol += f[3];
          seg.srcIdx = srcIdx;
          seg.srcLine = srcLine;
          seg.srcCol = srcCol;
        }
        segs.push(seg);
      }
    }
    lines.push(segs);
  }
  return lines;
}

/** 1-based 的 generated (line, col) → 源码 1-based 位置。取该行中最后一个 genCol <= 目标列的 segment。 */
function originalPositionFor(parsed, map, line1, col1) {
  const segs = parsed[line1 - 1];
  if (!segs || !segs.length) return null;
  let best = null;
  for (const s of segs) {
    if (s.srcLine === undefined) continue;
    if (s.genCol <= col1 - 1) best = s;
    else break;
  }
  if (!best) best = segs.find((s) => s.srcLine !== undefined);
  if (!best) return null;
  return {
    source: map.sources[best.srcIdx],
    line: best.srcLine + 1,
    column: best.srcCol + 1,
  };
}

/** base64 → 字符串。必须走 TextDecoder，直接 atob 会把 sourcesContent 里的非 ASCII 弄成乱码。 */
function decodeBase64Utf8(b64) {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

const basename = (p) => String(p).split(/[\\/]/).pop();

const INLINE_MAP_RE =
  /sourceMappingURL=data:application\/json;(?:charset=[^;]+;)?base64,([A-Za-z0-9+/=]+)/;
const EXTERNAL_MAP_RE = /\/\/[#@]\s*sourceMappingURL=(?!data:)(\S+)/;
// @vitejs/plugin-react v5 及以前会注入 __source 字面量，fileName 是完整绝对磁盘路径 ——
// React 19 runtime 虽然把这个参数丢了，但它还在编译产物文本里，是零配置拿绝对路径的来源。
// v6 起不再注入（React 19 反正不读），SWC 版插件也不注入，所以这条只是运气好时的快捷路径。
const FILENAME_LITERAL_RE = /fileName:\s*"((?:[^"\\]|\\.)*)"/;

const moduleCache = new Map();

async function loadModuleMap(url) {
  if (moduleCache.has(url)) return moduleCache.get(url);
  const promise = (async () => {
    const res = await fetch(url, { credentials: "omit" });
    if (!res.ok) throw new Error(`拉取模块失败 ${res.status}: ${url}`);
    const text = await res.text();

    let rawMap;
    const inline = INLINE_MAP_RE.exec(text);
    if (inline) {
      rawMap = JSON.parse(decodeBase64Utf8(inline[1]));
    } else {
      const external = EXTERNAL_MAP_RE.exec(text);
      if (!external) throw new Error(`模块没有 sourcemap: ${url}`);
      const mapRes = await fetch(new URL(external[1], url).href, {
        credentials: "omit",
      });
      if (!mapRes.ok) throw new Error(`拉取 .map 失败 ${mapRes.status}`);
      rawMap = await mapRes.json();
    }

    const fileNameHit = FILENAME_LITERAL_RE.exec(text);
    return {
      map: rawMap,
      parsed: parseMappings(rawMap.mappings),
      // 只有 babel 版 @vitejs/plugin-react 会注入这个；SWC / Next.js 链路上是 null
      fileNameLiteral: fileNameHit ? fileNameHit[1] : null,
    };
  })();
  moduleCache.set(url, promise);
  return promise;
}

// ---------- 磁盘绝对路径推断 ----------

/** 剥掉各家工具链给 sources 加的前缀，得到相对项目根的路径 */
function normalizeSourcePath(source) {
  return source
    .replace(/^webpack:\/\/\/?/, "") // webpack:///./src/x.tsx
    .replace(/^[^/]*\/\.\//, "") // webpack://my-proj/./src/x.tsx
    .replace(/^\.\//, "")
    .replace(/^\//, "");
}

/**
 * 判断一个候选值是不是真的磁盘绝对路径。
 * 光看开头的 "/" 不够 —— Vite 的 sources 是 "/src/App.tsx" 这种 URL 风格路径，不是磁盘路径。
 * 强信号：磁盘路径应当以模块 URL 的 pathname 结尾，且前面还多出一段（那段就是项目根）。
 */
function looksLikeDiskPath(candidate, moduleUrl) {
  if (/^[A-Za-z]:[\\/]/.test(candidate)) return true; // Windows 盘符
  if (!candidate.startsWith("/")) return false;
  const urlPath = new URL(moduleUrl).pathname;
  return candidate.endsWith(urlPath) && candidate.length > urlPath.length;
}

/**
 * Vite dev 是一模块一 URL，所以模块 URL 的 pathname 就是相对项目根的完整路径。
 * 这比 sourcemap 的 sources 可靠得多 —— sources 常常只有裸文件名（"index.tsx"），
 * 而一个项目里可能有上百个同名文件，拼出来必然是错的。
 * /@fs/ 开头的模块（monorepo 外部文件、link 的包）后面直接跟绝对路径，连项目根都不用配。
 */
function pathFromModuleUrl(moduleUrl, root) {
  const pathname = new URL(moduleUrl).pathname;
  if (pathname.startsWith("/@fs/")) return pathname.slice("/@fs".length);
  if (!root) return null;
  return root.replace(/\/+$/, "") + pathname;
}

/** 从最可靠到最将就，逐级尝试推出绝对路径 */
function inferAbsPath({ fileNameLiteral, map, source, moduleUrl }) {
  const fromFs = pathFromModuleUrl(moduleUrl, null);
  if (fromFs) return { path: fromFs, via: "Vite /@fs/ 前缀" };

  if (fileNameLiteral) return { path: fileNameLiteral, via: "fileName 字面量" };

  if (source && looksLikeDiskPath(source, moduleUrl)) {
    return { path: source, via: "sourcemap sources（本身是绝对路径）" };
  }

  if (map.sourceRoot && source) {
    const joined =
      map.sourceRoot.replace(/\/+$/, "") + "/" + normalizeSourcePath(source);
    if (joined.startsWith("/") || /^[A-Za-z]:[\\/]/.test(joined)) {
      return { path: joined, via: "sourceRoot + sources" };
    }
  }

  const root = getConfiguredRoot();
  if (!root) return null;

  const fromUrl = pathFromModuleUrl(moduleUrl, root);
  // basename 一致才敢用 URL 路径：不一致说明这个 URL 是多文件 bundle（webpack 那种），
  // 它的 pathname 和源文件没有对应关系。
  if (fromUrl && (!source || basename(fromUrl) === basename(source))) {
    return { path: fromUrl, via: "项目根 + 模块 URL 路径" };
  }
  if (source) {
    return {
      path: root.replace(/\/+$/, "") + "/" + normalizeSourcePath(source),
      via: "项目根 + sources",
    };
  }
  return null;
}

/** 把 _debugStack 拿到的 bundle 位置还原成 { absPath, line, column } */
async function resolveToSource(callSite) {
  const entry = await loadModuleMap(callSite.url);
  const pos = originalPositionFor(
    entry.parsed,
    entry.map,
    callSite.line,
    callSite.column,
  );
  if (!pos)
    throw new Error(
      `sourcemap 里没有 ${callSite.line}:${callSite.column} 的映射`,
    );

  const inferred = inferAbsPath({
    fileNameLiteral: entry.fileNameLiteral,
    map: entry.map,
    source: pos.source,
    moduleUrl: callSite.url,
  });
  if (!inferred) {
    // 区分"根本没配根"和"配了根但依然推不出"，否则看到同一句话没法判断下一步做什么
    const root = getConfiguredRoot();
    const where = `${pos.source}:${pos.line}:${pos.column}`;
    const err = new Error(
      root
        ? `源码位置是 ${where}，项目根已配为 ${root}，但仍推不出磁盘路径。` +
            `模块 URL 是 ${callSite.url}，sourcemap 的 sources 是 ${JSON.stringify(pos.source)}。`
        : `源码位置是 ${where}，但还没配项目根，推不出磁盘绝对路径。` +
            `点卡片上的「设置」填一次即可（也可以在插件的选项页里统一管理各 origin 的项目根）。`,
    );
    // 卡片位置有限，短文案上卡片，完整说明进 title
    err.short = root ? `${where} — 配了根仍推不出` : `${where} — 未配置项目根`;
    err.needsRoot = !root;
    throw err;
  }
  return {
    absPath: inferred.path,
    line: pos.line,
    column: pos.column,
    source: pos.source,
    via: inferred.via,
  };
}

// ---------- 跳编辑器 ----------

// scheme 是编辑器自带的，装了就能用，不需要装任何编辑器插件
function openInEditor({ absPath, line, column, via }) {
  const editor = getEditor();
  const url = `${editor.scheme}://file/${encodeURI(absPath)}:${line}:${column}`;
  console.log(
    "%c[source-inspect] 打开:",
    "color:#4f9cff",
    url,
    via ? `（路径来源: ${via}）` : "",
  );
  window.location.href = url;
}

function probe(dom) {
  const { fiber, key, node, hops } = findFiberFromDomOrAncestor(dom);
  if (!fiber) {
    return {
      ok: false,
      reason: "整条祖先链上都没有 React fiber（页面不是 React 渲染的）",
    };
  }

  const chain = walkUp(fiber);
  const hitSource = chain.find((n) => n.debugSource);
  const hitCallSite = chain.find((n) => n.jsxCallSite);

  let route, target;
  if (hitSource) {
    route = "debugSource";
    target = `${hitSource.debugSource.fileName}:${hitSource.debugSource.line}:${hitSource.debugSource.column}`;
  } else if (hitCallSite) {
    route = "debugStack";
    const s = hitCallSite.jsxCallSite;
    target = `${s.url}:${s.line}:${s.column}`;
  } else {
    route = "none";
    target = null;
  }

  return {
    ok: true,
    fiberKey: key,
    reactVersion: detectReactVersion(),
    route,
    target,
    // hops > 0 说明点击目标本身没有 fiber，结果来自第 hops 层祖先
    ancestorHops: hops,
    ancestorNode: hops > 0 ? node : null,
    // 供 sourcemap 还原用的原始数据
    callSite: hitCallSite ? hitCallSite.jsxCallSite : null,
    debugSourceRaw: hitSource ? hitSource.debugSource : null,
    strategy: {
      debugSource:
        "_debugSource 可用（React ≤18）：已是源码行列，直接可跳，不需要 sourcemap",
      debugStack:
        "_debugStack 可用（React 19）：拿到的是编译产物位置，需要 sourcemap 还原成源码行列",
      // production build 下 fiber 仍然存在，但所有 _debug* 字段被剥离，实测组件名也被压缩成 v1 之类
      none: "两条 _debug 路径都拿不到 —— 最常见原因是 production build（fiber 在，调试字段被剥离）",
    }[route],
    owner: (hitSource || hitCallSite || {}).name ?? null,
    componentChain: chain
      .filter((n) => n.name && COMPONENT_TAGS.has(n.tag))
      .map((n) => n.name),
    props: Object.keys(findProps(dom) || {}),
    fullChain: chain,
  };
}

// ---------- 交互层：Alt+hover 高亮，Alt+click 打印 ----------

const overlay = document.createElement("div");
Object.assign(overlay.style, {
  position: "fixed",
  pointerEvents: "none",
  zIndex: "2147483647",
  border: "2px solid #4f9cff",
  background: "rgba(79,156,255,.12)",
  borderRadius: "2px",
  display: "none",
});

const label = document.createElement("div");
Object.assign(label.style, {
  position: "fixed",
  pointerEvents: "none",
  zIndex: "2147483647",
  font: "12px/1.5 ui-monospace, monospace",
  background: "#1e1e1e",
  color: "#d4d4d4",
  padding: "4px 8px",
  borderRadius: "4px",
  // width: max-content 是关键 —— 没有它，fixed 元素靠近右边界时可用宽度不足，
  // 会被压成一条竖着排字的窄条（而不是溢出），测量也会测到错误的宽度
  width: "max-content",
  maxWidth: "460px",
  // 显式声明，不能指望目标页面有 CSS reset：content-box 下 padding 会加到 maxWidth 之外
  boxSizing: "border-box",
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
  display: "none",
  boxShadow: "0 2px 12px rgba(0,0,0,.4)",
});

// Alt+点击后固定下来的高亮框，和 hover 的 overlay 分开，这样鼠标移开它也不消失
const pinBox = document.createElement("div");
Object.assign(pinBox.style, {
  position: "fixed",
  pointerEvents: "none",
  zIndex: "2147483646",
  border: "2px solid #f0883e",
  background: "rgba(240,136,62,.10)",
  borderRadius: "2px",
  display: "none",
});

const LINK_COLOR = "#58a6ff";

const card = document.createElement("div");
Object.assign(card.style, {
  position: "fixed",
  zIndex: "2147483647",
  font: "12px/1.7 ui-monospace, SFMono-Regular, Menlo, monospace",
  background: "#1e1e1e",
  color: "#d4d4d4",
  border: "1px solid #3a3a3a",
  borderRadius: "8px",
  padding: "10px 12px",
  minWidth: "300px",
  maxWidth: "560px",
  boxSizing: "border-box", // 同上：长类名换行时 padding+border 不能把卡片撑出 maxWidth
  display: "none",
  boxShadow: "0 6px 24px rgba(0,0,0,.5)",
  pointerEvents: "auto", // 卡片要能点，和 overlay/label 不同
});

document.documentElement.append(overlay, label, pinBox, card);

let current = null;
let hintToken = 0; // 防止慢的 sourcemap 结果覆盖掉新的 hover

function hideHint() {
  overlay.style.display = "none";
  label.style.display = "none";
  current = null;
}

/**
 * 纯几何计算：在目标矩形旁边找一个放浮层的位置。两条硬要求 —— 不遮挡目标、不超出视口。
 * 依次试 上 / 下 / 右 / 左，取第一个同时满足两条的。抽成纯函数是为了能单测边界情况。
 * 见 test/placement.test.mjs（改这里要同步那边）。
 */
function computePlacement({
  w,
  h,
  rect,
  vw,
  vh,
  prefer = "above",
  margin = 8,
}) {
  const M = margin;
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const overlaps = (l, t) =>
    l < rect.right && l + w > rect.left && t < rect.bottom && t + h > rect.top;
  const inViewport = (l, t) =>
    l >= M && t >= M && l + w <= vw - M && t + h <= vh - M;
  const overlapArea = (l, t) => {
    const ox = Math.max(
      0,
      Math.min(l + w, rect.right) - Math.max(l, rect.left),
    );
    const oy = Math.max(
      0,
      Math.min(t + h, rect.bottom) - Math.max(t, rect.top),
    );
    return ox * oy;
  };

  const candidates = [];
  // 上下方向：水平跟随目标左边缘并夹进视口；垂直已经错开，所以不会重叠
  const vertical = (top) =>
    candidates.push({
      left: clamp(rect.left, M, Math.max(M, vw - w - M)),
      top,
    });
  // 左右方向：垂直跟随目标上边缘并夹进视口
  const horizontal = (left) =>
    candidates.push({ left, top: clamp(rect.top, M, Math.max(M, vh - h - M)) });

  if (prefer === "below") {
    vertical(rect.bottom + M);
    vertical(rect.top - h - M);
  } else {
    vertical(rect.top - h - M);
    vertical(rect.bottom + M);
  }
  horizontal(rect.right + M);
  horizontal(rect.left - w - M);

  const pick = candidates.find(
    (c) => inViewport(c.left, c.top) && !overlaps(c.left, c.top),
  );
  if (pick) return pick;

  // 目标几乎占满视口，四周都躲不开：优先保证浮层完整可见，在左上/右下里选重叠更小的
  const tl = { left: M, top: M };
  const br = { left: Math.max(M, vw - w - M), top: Math.max(M, vh - h - M) };
  return overlapArea(tl.left, tl.top) <= overlapArea(br.left, br.top) ? tl : br;
}

/**
 * 必须先移到 (0,0) 再测量 —— fixed 元素直接设一个靠右的 left，可用宽度就不够了，
 * 内容会被压成竖排窄条，此时量到的 offsetWidth 也是错的。
 */
function placeNear(el, rect, prefer = "above") {
  el.style.display = "block";
  el.style.left = "0px";
  el.style.top = "0px";
  const { left, top } = computePlacement({
    w: el.offsetWidth,
    h: el.offsetHeight,
    rect,
    vw: window.innerWidth,
    vh: window.innerHeight,
    prefer,
  });
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function showHint(dom) {
  const r = probe(dom);

  // 回退到祖先时，高亮框画在真正命中的那个节点上，避免用户误以为定位的是自己点的元素
  const highlighted = r.ancestorNode || dom;
  const rect = highlighted.getBoundingClientRect();
  Object.assign(overlay.style, {
    display: "block",
    top: `${rect.top}px`,
    left: `${rect.left}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    borderStyle: r.ancestorNode ? "dashed" : "solid",
  });

  const via =
    r.ok && r.ancestorHops > 0
      ? `（无 fiber，取上 ${r.ancestorHops} 层祖先）\n`
      : "";
  // 文本变化会改变尺寸，异步结果回来后必须重新定位，否则可能溢出视口
  const place = () => placeNear(label, rect, "above");

  if (!r.ok) {
    label.textContent = `✗ ${r.reason}`;
  } else if (r.route === "debugSource") {
    // React <=18：fiber 上已是源码位置，无需还原
    const s = r.debugSourceRaw;
    label.textContent = `${via}✓ ${basename(s.fileName)}:${s.line}:${s.column ?? 1}   <${r.owner}>`;
  } else if (r.route === "debugStack") {
    // React 19：先显示编译产物位置，sourcemap 是异步的，回来了再替换。
    // hover 只给速览，完整绝对路径留给卡片 —— 塞进浮层会让它长到没法放。
    const token = ++hintToken;
    const cs = r.callSite;
    label.textContent = `${via}◐ ${basename(new URL(cs.url).pathname)}:${cs.line}:${cs.column} 解析中…`;
    place();
    resolveToSource(cs).then(
      (pos) => {
        if (token !== hintToken) return; // 鼠标已经移到别处，丢弃过期结果
        label.textContent = `${via}✓ ${basename(pos.source)}:${pos.line}:${pos.column}   <${r.owner}>`;
        place();
      },
      (err) => {
        if (token !== hintToken) return;
        label.textContent = `${via}✗ ${err.short || err.message}`;
        place();
      },
    );
    current = dom;
    return;
  } else {
    label.textContent = `${via}⚠ 无位置信息 | ${r.componentChain.slice(0, 3).reverse().join(" → ") || "组件链为空"}`;
  }

  place();
  current = dom;
}

// ---------- 固定卡片 ----------

function closeCard() {
  card.style.display = "none";
  pinBox.style.display = "none";
  card.replaceChildren();
  lastCard = null;
}

/** 从 fiber 链里取出前 max 个带位置信息的层级：第 0 个是当前元素，往后是各级父级 */
function collectPositions(chain, max) {
  const out = [];
  for (const node of chain) {
    if (!node.jsxCallSite && !node.debugSource) continue;
    out.push(node);
    if (out.length >= max) break;
  }
  return out;
}

/** 把一个 span 变成可点击的蓝色位置链接 */
function setLink(el, text, target) {
  el.textContent = text;
  el.style.color = LINK_COLOR;
  el.style.cursor = "pointer";
  el.style.textDecoration = "none";
  el.title = `${target.absPath}:${target.line}:${target.column}\n点击在编辑器中打开`;
  el.onmouseenter = () => (el.style.textDecoration = "underline");
  el.onmouseleave = () => (el.style.textDecoration = "none");
  el.onclick = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    openInEditor(target);
  };
}

/** React ≤18 直接就有源码位置；React 19 要异步等 sourcemap 还原 */
function fillPositionLink(el, entry) {
  if (entry.debugSource) {
    const s = entry.debugSource;
    const target = { absPath: s.fileName, line: s.line, column: s.column ?? 1 };
    setLink(
      el,
      `${basename(s.fileName)}:${target.line}:${target.column}`,
      target,
    );
    return;
  }
  el.textContent = "解析 sourcemap…";
  el.style.color = "#7d8590";
  resolveToSource(entry.jsxCallSite).then(
    (pos) =>
      setLink(el, `${basename(pos.source)}:${pos.line}:${pos.column}`, pos),
    (err) => {
      el.textContent = `✗ ${err.short || err.message}`;
      el.style.color = "#f85149";
      el.title = err.message; // 悬停看完整说明和修复命令
    },
  );
}

function row(labelText, valueNode, extra) {
  const line = document.createElement("div");
  Object.assign(line.style, {
    display: "flex",
    gap: "8px",
    alignItems: "baseline",
    padding: "1px 0",
  });
  const k = document.createElement("span");
  k.textContent = labelText;
  Object.assign(k.style, {
    color: "#7d8590",
    flex: "0 0 auto",
    minWidth: "58px",
  });
  line.append(k, valueNode);
  if (extra) line.append(extra);
  return line;
}

/**
 * 位置行右边显示"这行 JSX 写在哪个组件的渲染函数里"（取自栈帧的函数名）。
 * 比显示 fiber 的 tagName 有信息量得多，更重要的是能解释一个看起来矛盾的现象：
 * 作为 children / props 传下去的元素，是在**父组件**里创建的，却挂在**子组件**的
 * fiber 子树上 —— 于是位置所属组件和组件链最内层不是同一个，两者都没错。
 */
function describeNode(entry) {
  const fn = entry.jsxCallSite && entry.jsxCallSite.fn;
  if (fn && fn !== "(anonymous)") return `写于 ${fn}`;
  return `<${entry.name ?? "?"}>`;
}

/** 卡片上的编辑器选择器。位置链接跳转时读的就是这里的值 */
function editorRow() {
  const sel = document.createElement("select");
  Object.assign(sel.style, {
    background: "#2a2a2a",
    color: "#d4d4d4",
    border: "1px solid #3a3a3a",
    borderRadius: "4px",
    font: "inherit",
    padding: "1px 4px",
    cursor: "pointer",
  });
  for (const editor of EDITORS) {
    const opt = document.createElement("option");
    opt.value = editor.id;
    opt.textContent = editor.label;
    sel.append(opt);
  }
  sel.value = getEditor().id;
  sel.onchange = () => setEditor(sel.value);
  sel.onclick = (ev) => ev.stopPropagation();
  return row("编辑器", sel);
}

/** 卡片底部的项目根一行：随时能看到配没配、点一下就能改 */
function rootConfigRow(onChanged) {
  const value = document.createElement("span");
  const root = getConfiguredRoot();
  value.textContent = root || "(未配置)";
  value.style.color = root ? "#d4d4d4" : "#d29922";

  const action = document.createElement("span");
  action.textContent = root ? "[修改]" : "[设置]";
  Object.assign(action.style, {
    color: LINK_COLOR,
    cursor: "pointer",
    flex: "0 0 auto",
  });
  action.onclick = (ev) => {
    ev.stopPropagation();
    const input = prompt(
      `${location.origin} 对应的项目根目录（磁盘绝对路径）：`,
      getConfiguredRoot() || "",
    );
    if (input === null) return;
    setProjectRoot(input.trim().replace(/\/+$/, ""));
    onChanged(); // 就地重渲染，位置行会用新根重算一次
  };

  return row("项目根", value, action);
}

// 记住最后一次探测，配置变更（options 页改动、卡片上改）后能就地重渲染
let lastCard = null;

function showCard(dom, r) {
  lastCard = { dom, result: r };
  card.replaceChildren();

  const anchor = r.ancestorNode || dom;
  const rect = anchor.getBoundingClientRect();
  Object.assign(pinBox.style, {
    display: "block",
    top: `${rect.top}px`,
    left: `${rect.left}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  });

  // 头部：元素标签 + 关闭按钮
  const head = document.createElement("div");
  Object.assign(head.style, {
    display: "flex",
    justifyContent: "space-between",
    // 类名多时标题会换行，✕ 要留在第一行而不是垂直居中到中间
    alignItems: "flex-start",
    gap: "12px",
    marginBottom: "6px",
    paddingBottom: "6px",
    borderBottom: "1px solid #3a3a3a",
  });
  const title = document.createElement("span");
  // SVG 元素的 className 是 SVGAnimatedString 不是字符串，得走 getAttribute
  const rawClass = (
    typeof anchor.className === "string"
      ? anchor.className
      : anchor.getAttribute("class") || ""
  ).trim();
  const classSuffix = rawClass ? "." + rawClass.split(/\s+/).join(".") : "";
  title.textContent = `<${anchor.tagName.toLowerCase()}>${classSuffix}`;
  Object.assign(title.style, {
    color: "#e5c07b",
    fontWeight: "600",
    // minWidth:0 是 flex 子项能换行的前提，否则长类名会把卡片撑过 maxWidth
    flex: "1 1 auto",
    minWidth: "0",
    wordBreak: "break-all",
  });
  const closeBtn = document.createElement("span");
  closeBtn.textContent = "✕";
  Object.assign(closeBtn.style, {
    color: "#7d8590",
    cursor: "pointer",
    padding: "0 2px",
    flex: "0 0 auto",
  });
  closeBtn.onclick = (ev) => {
    ev.stopPropagation();
    closeCard();
  };
  head.append(title, closeBtn);
  card.append(head);

  if (!r.ok) {
    const err = document.createElement("div");
    err.textContent = `✗ ${r.reason}`;
    err.style.color = "#f85149";
    card.append(err);
  } else {
    if (r.ancestorHops > 0) {
      const warn = document.createElement("div");
      warn.textContent = `⚠ 该元素无 fiber，以下信息取自上 ${r.ancestorHops} 层祖先`;
      Object.assign(warn.style, { color: "#d29922", marginBottom: "4px" });
      card.append(warn);
    }

    const positions = collectPositions(r.fullChain, 2);
    if (!positions.length) {
      const none = document.createElement("div");
      none.textContent = `⚠ 拿不到位置信息：${r.strategy}`;
      none.style.color = "#d29922";
      card.append(none);
    } else {
      const labels = ["当前元素", "父级"];
      positions.forEach((entry, i) => {
        const link = document.createElement("span");
        fillPositionLink(link, entry);
        const who = document.createElement("span");
        who.textContent = describeNode(entry);
        Object.assign(who.style, { color: "#7d8590", flex: "0 0 auto" });
        card.append(row(labels[i] ?? `上${i}层`, link, who));
      });
    }

    card.append(
      row(
        "组件链",
        (() => {
          const s = document.createElement("span");
          // componentChain 原始顺序是由内到外。先截取最内 5 层（离点击元素最近、最相关），
          // 再反转成由外到内显示，读起来像面包屑；被截断时前面补省略号。
          const innermost = r.componentChain.slice(0, 5);
          const shown = innermost.reverse().join(" → ");
          s.textContent = shown
            ? (r.componentChain.length > 5 ? "… → " : "") + shown
            : "(无)";
          s.style.color = "#d4d4d4";
          return s;
        })(),
      ),
    );
    card.append(
      row(
        "React",
        (() => {
          const s = document.createElement("span");
          s.textContent = `${r.reactVersion ?? "版本未知"} · ${r.route}`;
          s.style.color = "#7d8590";
          return s;
        })(),
      ),
    );

    // 编辑器对所有路径都要用，总是显示
    card.append(editorRow());
    // 只有 debugStack 路径要靠项目根推路径，debugSource 路径不需要，不显示免得干扰
    if (r.route === "debugStack") {
      card.append(rootConfigRow(() => showCard(dom, r)));
    }
  }

  placeNear(card, rect, "below");
}

const isOwnUi = (el) =>
  el === overlay || el === label || el === pinBox || card.contains(el);

/** 占满视口的层：全屏遮罩、portal 根、页面根容器。它们挡在前面但从来不是用户想定位的东西 */
function isFullscreenLayer(el) {
  const r = el.getBoundingClientRect();
  return (
    r.width >= window.innerWidth * 0.95 && r.height >= window.innerHeight * 0.95
  );
}

/**
 * 取事件真正该作用的元素。event.target 不够用的三种情况：
 *  1. 全屏遮罩 / portal 层盖在上面，target 是那层（无 fiber 时甚至是 <html>）；
 *  2. 遮罩本身是 React 渲染的（Chakra / Radix 都是），有 fiber，光看 target 会定位到遮罩；
 *  3. 页面自己的 mousedown 处理已经把 DOM 换掉（下拉 toggle、outside-click 关闭），
 *     到 click 阶段原元素已不在树上，target 回退成祖先。
 * 办法是按鼠标坐标取整条命中栈，挑第一个"带 fiber 且不占满视口"的元素。
 */
function pickTarget(e) {
  const direct = e.target instanceof Element ? e.target : null;
  const stack = [];
  if (direct && !isOwnUi(direct)) stack.push(direct);
  if (typeof document.elementsFromPoint === "function") {
    for (const el of document.elementsFromPoint(e.clientX, e.clientY) || []) {
      if (!isOwnUi(el) && !stack.includes(el)) stack.push(el);
    }
  }

  const withFiber = stack.filter((el) => findFiber(el).fiber);
  if (!withFiber.length) return direct;
  // 优先要具体元素；整条栈都是全屏层时（点在页面空白处）才退回最上层那个
  return withFiber.find((el) => !isFullscreenLayer(el)) || withFiber[0];
}

// Alt + 鼠标操作是插件的专用手势，必须从 pointerdown 就整串吞掉。
// 只在 click 里 preventDefault 太晚了 —— 页面的 mousedown 逻辑已经跑完并改了 DOM。
let pendingTarget = null;
for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
  document.addEventListener(
    type,
    (e) => {
      if (!e.altKey) return;
      if (e.target instanceof Node && card.contains(e.target)) return; // 卡片自身的交互放行
      e.preventDefault();
      e.stopPropagation();
      // DOM 此刻还是完整的，先把目标记下来给随后的 click 用
      if (type === "pointerdown" || type === "mousedown")
        pendingTarget = pickTarget(e);
    },
    true,
  );
}

document.addEventListener(
  "mousemove",
  (e) => {
    if (!e.altKey) return hideHint();
    const target = pickTarget(e);
    if (!(target instanceof Element) || isOwnUi(target)) return;
    if (target !== current) showHint(target);
  },
  true,
);

document.addEventListener("keyup", (e) => {
  if (e.key === "Alt") hideHint(); // 只收起 hover 提示，固定的卡片留着
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && card.style.display !== "none") {
    e.stopPropagation();
    closeCard();
  }
});

document.addEventListener(
  "click",
  (e) => {
    // 卡片自己的点击（关闭按钮、位置链接、设置）由各自的 onclick 处理，不要在这里重新探测
    if (e.target instanceof Node && card.contains(e.target)) return;

    if (!e.altKey) {
      // 点卡片外面就关掉。不 preventDefault —— 页面自己的点击逻辑照常走
      if (card.style.display !== "none") closeCard();
      return;
    }
    e.preventDefault();
    e.stopPropagation();

    // 优先用 pointerdown 时记下的目标：那时页面还没来得及改 DOM
    const target = pendingTarget || pickTarget(e);
    pendingTarget = null;
    const r = probe(target);
    console.group(
      "%c[source-inspect] 探测结果",
      "color:#4f9cff;font-weight:bold",
    );
    console.log("目标 DOM:", target);
    if (target !== e.target) {
      console.log(
        `%c↑ event.target 原本是 <${e.target instanceof Element ? e.target.tagName.toLowerCase() : e.target}>，` +
          "被遮罩层或 DOM 变动干扰，已按鼠标坐标纠正",
        "color:#d29922",
      );
    }
    if (!r.ok) {
      console.warn(r.reason);
    } else {
      console.log(
        "React 版本:",
        r.reactVersion ?? "(检测不到，装 React DevTools 后可读到)",
      );
      console.log("fiber 挂载 key:", r.fiberKey);
      console.log("%c走的路径: " + r.strategy, "color:#e5c07b");
      if (r.ancestorHops > 0)
        console.warn(
          `点击目标本身无 fiber，结果取自上 ${r.ancestorHops} 层祖先:`,
          r.ancestorNode,
        );
      console.log("定位目标:", r.target ?? "(无)");
      console.log("归属组件:", r.owner ?? "(无)");
      console.log("组件链 (由内到外):", r.componentChain);
      console.log("该节点 props:", r.props);
      console.log("完整 fiber 链原始数据:", r.fullChain);
    }
    console.groupEnd();

    // 点击不再直接跳编辑器 —— 固定下来出卡片，由卡片上的位置链接决定跳哪一层
    hideHint();
    showCard(target, r);
  },
  true,
);

console.log(
  "%c[source-inspect] 探针已注入。Alt+移动鼠标 查看，Alt+点击 固定卡片，点卡片上的蓝色位置跳编辑器，Esc 关闭。",
  "color:#4f9cff",
);
