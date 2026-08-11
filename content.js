// Feasibility probe: starting from a DOM node, discover how much source information React exposes.
// It does not resolve source maps or open editors. Alt+hover highlights; Alt+click inspects and logs.
//
// Two verified paths (see README):
//   React <=18: fiber._debugSource provides file:line:column directly, with no source map required.
//   React 19: _debugSource was removed; use fiber._debugStack (an Error). Its first user-code
//   frame is the JSX call site that created the element, at a bundle location that needs a source map.

// ---------- Configuration: editor + project root ----------
// The authoritative data is in chrome.storage.local and proxied by bridge.js because the MAIN world
// cannot access chrome.* APIs, while the probe must run there to read DOM __reactFiber$ expandos.
// Keep an in-memory cache for synchronous getEditor/getConfiguredRoot reads on the hover hot path.
// If the bridge is unavailable (missing bridge.js or storage failure), fall back to page localStorage.

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
    return ""; // Some pages disable localStorage.
  }
}

function lsWrite(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch (e) {
    console.warn("[source-inspect] Failed to write localStorage:", e.message);
  }
}

// Read localStorage first so the feature works before the bridge replies and with data from earlier versions.
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

  // The options page pushes changes through the bridge; rerender an open card in place.
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
      if (pendingRequests.delete(id)) resolve(null); // bridge.js is missing or did not respond.
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
      "[source-inspect] bridge.js did not respond; falling back to page localStorage (reinstall the extension to restore it)",
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

/** Write both stores: chrome.storage is authoritative across origins; localStorage is a bridge fallback. */
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

/** Find the React Fiber attached to a DOM node. No Fiber means it is not React-rendered or is a production build. */
function findFiber(dom) {
  for (const key in dom) {
    for (const prefix of FIBER_KEYS) {
      if (key.startsWith(prefix)) return { fiber: dom[key], key };
    }
  }
  return { fiber: null, key: null };
}

/**
 * The clicked target may be native DOM inserted through innerHTML, a third-party library, or a Portal,
 * and therefore have no Fiber. Search upward for the nearest React ancestor; its rendering container is useful.
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

/** fiber.type can be a string ('div'), function component, class, or memo/forwardRef wrapper. */
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

// ---------- React 19: extract the JSX call site from _debugStack ----------

const FRAME_RE = /at\s+(?:async\s+)?(?:(.+?)\s+\()?(\S+?):(\d+):(\d+)\)?$/;

/** Skip framework frames; they are not the target. */
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
  // The first non-framework frame is the line that created this JSX element in compiled output.
  const jsxCallSite = frames.find((f) => !isFrameworkFrame(f.url)) || null;
  return { jsxCallSite, allFrames: frames };
}

/** Walk fiber.return upward and record the data available at each level. */
function walkUp(startFiber, limit = 30) {
  const chain = [];
  let fiber = startFiber;
  while (fiber && chain.length < limit) {
    const stack = parseDebugStack(fiber);
    chain.push({
      tag: fiber.tag,
      name: typeName(fiber.type),
      // React <=18 path
      debugSource: fiber._debugSource
        ? {
            fileName: fiber._debugSource.fileName,
            line: fiber._debugSource.lineNumber,
            column: fiber._debugSource.columnNumber ?? null,
          }
        : null,
      // React 19 path
      jsxCallSite: stack ? stack.jsxCallSite : null,
      stackFrames: stack ? stack.allFrames : null,
      debugOwner: fiber._debugOwner ? typeName(fiber._debugOwner.type) : null,
      debugFields: Object.keys(fiber).filter((k) => k.startsWith("_debug")),
    });
    fiber = fiber.return;
  }
  return chain;
}

// Component React WorkTags: function, class, forwardRef, memo, and simple memo.
// Name capitalization misses lowercased forwardRef(X) and memo(X) wrappers, while name checks also admit
// Fragment, Suspense, and Provider because their types are symbols.
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

// ---------- Source-map resolution: bundle location → source line and column ----------
// Hand-written VLQ decoding in plain JS avoids dependencies and MV3 WASM/CSP issues.

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

/** Mapping string → segments grouped by generated line (all 0-based). */
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

/** 1-based generated (line, col) → 1-based source position using the last segment whose genCol is not greater than the target. */
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

/** base64 → string. TextDecoder is required because direct atob corrupts non-ASCII sourcesContent. */
function decodeBase64Utf8(b64) {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

const basename = (p) => String(p).split(/[\\/]/).pop();

const INLINE_MAP_RE =
  /sourceMappingURL=data:application\/json;(?:charset=[^;]+;)?base64,([A-Za-z0-9+/=]+)/;
const EXTERNAL_MAP_RE = /\/\/[#@]\s*sourceMappingURL=(?!data:)(\S+)/;
// @vitejs/plugin-react v5 and earlier inject a __source literal whose fileName is an absolute disk path.
// React 19 discards the parameter at runtime, but it remains in compiled output and enables zero-config paths.
// v6 and the SWC plugin do not inject it, so this is only an opportunistic fast path.
const FILENAME_LITERAL_RE = /fileName:\s*"((?:[^"\\]|\\.)*)"/;

const moduleCache = new Map();

async function loadModuleMap(url) {
  if (moduleCache.has(url)) return moduleCache.get(url);
  const promise = (async () => {
    const res = await fetch(url, { credentials: "omit" });
    if (!res.ok) throw new Error(`Failed to fetch module (${res.status}): ${url}`);
    const text = await res.text();

    let rawMap;
    const inline = INLINE_MAP_RE.exec(text);
    if (inline) {
      rawMap = JSON.parse(decodeBase64Utf8(inline[1]));
    } else {
      const external = EXTERNAL_MAP_RE.exec(text);
      if (!external) throw new Error(`Module has no source map: ${url}`);
      const mapRes = await fetch(new URL(external[1], url).href, {
        credentials: "omit",
      });
      if (!mapRes.ok) throw new Error(`Failed to fetch .map (${mapRes.status})`);
      rawMap = await mapRes.json();
    }

    const fileNameHit = FILENAME_LITERAL_RE.exec(text);
    return {
      map: rawMap,
      parsed: parseMappings(rawMap.mappings),
      // Only the Babel variant of @vitejs/plugin-react injects this; it is null for SWC and Next.js.
      fileNameLiteral: fileNameHit ? fileNameHit[1] : null,
    };
  })();
  moduleCache.set(url, promise);
  return promise;
}

// ---------- Absolute disk-path inference ----------

/** Remove toolchain prefixes from sources to obtain a project-root-relative path. */
function normalizeSourcePath(source) {
  return source
    .replace(/^webpack:\/\/\/?/, "") // webpack:///./src/x.tsx
    .replace(/^[^/]*\/\.\//, "") // webpack://my-proj/./src/x.tsx
    .replace(/^\.\//, "")
    .replace(/^\//, "");
}

/**
 * Determine whether a candidate is truly an absolute disk path.
 * A leading slash is insufficient: Vite sources can be URL-style paths such as /src/App.tsx.
 * A strong signal is that the path ends in the module URL pathname and has an additional project-root prefix.
 */
function looksLikeDiskPath(candidate, moduleUrl) {
  if (/^[A-Za-z]:[\\/]/.test(candidate)) return true; // Windows drive letter
  if (!candidate.startsWith("/")) return false;
  const urlPath = new URL(moduleUrl).pathname;
  return candidate.endsWith(urlPath) && candidate.length > urlPath.length;
}

/**
 * Vite dev serves one module per URL, so its pathname is the full path relative to the project root.
 * This is more reliable than source-map sources, which are often bare names such as index.tsx and may repeat.
 * Modules beginning with /@fs/ point directly to absolute paths for external monorepo files and linked packages.
 */
function pathFromModuleUrl(moduleUrl, root) {
  const pathname = new URL(moduleUrl).pathname;
  if (pathname.startsWith("/@fs/")) return pathname.slice("/@fs".length);
  if (!root) return null;
  return root.replace(/\/+$/, "") + pathname;
}

/** Infer an absolute path from the most reliable source to the least. */
function inferAbsPath({ fileNameLiteral, map, source, moduleUrl }) {
  const fromFs = pathFromModuleUrl(moduleUrl, null);
  if (fromFs) return { path: fromFs, via: "Vite /@fs/ prefix" };

  if (fileNameLiteral) return { path: fileNameLiteral, via: "fileName literal" };

  if (source && looksLikeDiskPath(source, moduleUrl)) {
    return { path: source, via: "source-map sources (already absolute)" };
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
  // Use the URL path only when basenames match. A mismatch means a multi-file bundle such as Webpack,
  // whose pathname has no correspondence to the source file.
  if (fromUrl && (!source || basename(fromUrl) === basename(source))) {
    return { path: fromUrl, via: "project root + module URL path" };
  }
  if (source) {
    return {
      path: root.replace(/\/+$/, "") + "/" + normalizeSourcePath(source),
      via: "project root + sources",
    };
  }
  return null;
}

/** Resolve a bundle location from _debugStack to { absPath, line, column }. */
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
      `Source map has no mapping for ${callSite.line}:${callSite.column}`,
    );

  const inferred = inferAbsPath({
    fileNameLiteral: entry.fileNameLiteral,
    map: entry.map,
    source: pos.source,
    moduleUrl: callSite.url,
  });
  if (!inferred) {
    // Distinguish a missing root from a configured root that still cannot infer a path.
    const root = getConfiguredRoot();
    const where = `${pos.source}:${pos.line}:${pos.column}`;
    const err = new Error(
      root
        ? `The source location is ${where}. Project root is ${root}, but an absolute disk path could not be inferred. ` +
            `Module URL: ${callSite.url}; source-map source: ${JSON.stringify(pos.source)}.`
        : `The source location is ${where}, but no project root is configured, so an absolute disk path cannot be inferred. ` +
            `Select [Settings] on the card once, or manage project roots for all origins in the extension options.`,
    );
    // Card space is limited: show a short message and keep the full explanation in the title.
    err.short = root ? `${where} — path unavailable with configured root` : `${where} — project root not configured`;
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

// ---------- Open in editor ----------

// The editor provides its own URL scheme, so no editor extension is needed.
function openInEditor({ absPath, line, column, via }) {
  const editor = getEditor();
  const url = `${editor.scheme}://file/${encodeURI(absPath)}:${line}:${column}`;
  console.log(
    "%c[source-inspect] Opening:",
    "color:#4f9cff",
    url,
    via ? `(path source: ${via})` : "",
  );
  window.location.href = url;
}

function probe(dom) {
  const { fiber, key, node, hops } = findFiberFromDomOrAncestor(dom);
  if (!fiber) {
    return {
      ok: false,
      reason: "No React Fiber exists anywhere in the ancestor chain (the page is not React-rendered)",
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
    // hops > 0 means the clicked target has no Fiber; the result comes from that ancestor level.
    ancestorHops: hops,
    ancestorNode: hops > 0 ? node : null,
    // Raw data used for source-map resolution.
    callSite: hitCallSite ? hitCallSite.jsxCallSite : null,
    debugSourceRaw: hitSource ? hitSource.debugSource : null,
    strategy: {
      debugSource:
        "_debugSource is available (React ≤18): it already contains source coordinates and needs no source map",
      debugStack:
        "_debugStack is available (React 19): it contains a compiled location that needs source-map resolution",
      // Production builds retain Fiber but strip all _debug* fields; component names may also be minified.
      none: "Neither _debug path is available — the most common cause is a production build with debug fields stripped",
    }[route],
    owner: (hitSource || hitCallSite || {}).name ?? null,
    componentChain: chain
      .filter((n) => n.name && COMPONENT_TAGS.has(n.tag))
      .map((n) => n.name),
    props: Object.keys(findProps(dom) || {}),
    fullChain: chain,
  };
}

// ---------- Interaction layer: Alt+hover highlights, Alt+click logs ----------

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
  // width: max-content is essential. Without it, a fixed element near the right edge gets compressed
  // into a narrow vertical column instead of overflowing, and its measured width is wrong.
  width: "max-content",
  maxWidth: "460px",
  // Declare this explicitly: the target page may lack a CSS reset, and content-box adds padding beyond maxWidth.
  boxSizing: "border-box",
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
  display: "none",
  boxShadow: "0 2px 12px rgba(0,0,0,.4)",
});

// The highlight pinned by Alt+click is separate from the hover overlay so it survives pointer movement.
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
  boxSizing: "border-box", // Long class names may wrap, but padding and border must not exceed maxWidth.
  display: "none",
  boxShadow: "0 6px 24px rgba(0,0,0,.5)",
  pointerEvents: "auto", // The card must be interactive, unlike the overlay and label.
});

document.documentElement.append(overlay, label, pinBox, card);

let current = null;
let hintToken = 0; // Prevent a slow source-map result from overwriting a newer hover.

function hideHint() {
  overlay.style.display = "none";
  label.style.display = "none";
  current = null;
}

/**
 * Pure geometry: place an overlay beside the target rectangle without overlapping it or leaving the viewport.
 * Try above, below, right, then left and take the first valid candidate. This is pure for boundary testing.
 * Keep this in sync with test/placement.test.mjs.
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
  // Vertical positions follow the target's left edge and clamp horizontally; their vertical offset prevents overlap.
  const vertical = (top) =>
    candidates.push({
      left: clamp(rect.left, M, Math.max(M, vw - w - M)),
      top,
    });
  // Horizontal positions follow the target's top edge and clamp vertically.
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

  // If the target nearly fills the viewport, keep the overlay fully visible and choose the lesser overlap at top-left or bottom-right.
  const tl = { left: M, top: M };
  const br = { left: Math.max(M, vw - w - M), top: Math.max(M, vh - h - M) };
  return overlapArea(tl.left, tl.top) <= overlapArea(br.left, br.top) ? tl : br;
}

/**
 * Measure at (0,0) first. Setting a fixed element near the right edge restricts its available width,
 * compresses its content into a narrow vertical column, and makes offsetWidth inaccurate.
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

  // When falling back to an ancestor, highlight the actual matched node to avoid implying the clicked element was resolved.
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
      ? `(no Fiber; using ancestor ${r.ancestorHops} level(s) up)\n`
      : "";
  // Text changes affect size, so reposition after async results to prevent viewport overflow.
  const place = () => placeNear(label, rect, "above");

  if (!r.ok) {
    label.textContent = `✗ ${r.reason}`;
  } else if (r.route === "debugSource") {
    // React <=18: Fiber already contains the source location.
    const s = r.debugSourceRaw;
    label.textContent = `${via}✓ ${basename(s.fileName)}:${s.line}:${s.column ?? 1}   <${r.owner}>`;
  } else if (r.route === "debugStack") {
    // React 19: show the compiled location first, then replace it when the async source map resolves.
    // Hover is a preview; reserve full absolute paths for the card so the overlay remains placeable.
    const token = ++hintToken;
    const cs = r.callSite;
    label.textContent = `${via}◐ ${basename(new URL(cs.url).pathname)}:${cs.line}:${cs.column} Resolving…`;
    place();
    resolveToSource(cs).then(
      (pos) => {
        if (token !== hintToken) return; // The pointer moved elsewhere; discard this stale result.
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
    label.textContent = `${via}⚠ No location information | ${r.componentChain.slice(0, 3).reverse().join(" → ") || "empty component chain"}`;
  }

  place();
  current = dom;
}

// ---------- Pinned card ----------

function closeCard() {
  card.style.display = "none";
  pinBox.style.display = "none";
  card.replaceChildren();
  lastCard = null;
}

/** Collect the first max levels with location information from the Fiber chain; index 0 is the current element. */
function collectPositions(chain, max) {
  const out = [];
  for (const node of chain) {
    if (!node.jsxCallSite && !node.debugSource) continue;
    out.push(node);
    if (out.length >= max) break;
  }
  return out;
}

/** Turn a span into a clickable blue location link. */
function setLink(el, text, target) {
  el.textContent = text;
  el.style.color = LINK_COLOR;
  el.style.cursor = "pointer";
  el.style.textDecoration = "none";
  el.title = `${target.absPath}:${target.line}:${target.column}\nClick to open in editor`;
  el.onmouseenter = () => (el.style.textDecoration = "underline");
  el.onmouseleave = () => (el.style.textDecoration = "none");
  el.onclick = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    openInEditor(target);
  };
}

/** React ≤18 provides source locations directly; React 19 waits for asynchronous source-map resolution. */
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
  el.textContent = "Resolving source map…";
  el.style.color = "#7d8590";
  resolveToSource(entry.jsxCallSite).then(
    (pos) =>
      setLink(el, `${basename(pos.source)}:${pos.line}:${pos.column}`, pos),
    (err) => {
      el.textContent = `✗ ${err.short || err.message}`;
      el.style.color = "#f85149";
      el.title = err.message; // Hover for the full explanation and remediation instructions.
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
 * The right side of a location row names the component render function that wrote the JSX, from the stack frame.
 * This is more useful than a Fiber tag name and explains why an element passed as children or props can be created
 * in a parent component but attached to a child Fiber subtree: the location owner and innermost chain component differ.
 */
function describeNode(entry) {
  const fn = entry.jsxCallSite && entry.jsxCallSite.fn;
  if (fn && fn !== "(anonymous)") return `written in ${fn}`;
  return `<${entry.name ?? "?"}>`;
}

/** Editor selector in the card. Location links use this value. */
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
  return row("Editor", sel);
}

/** Project-root row at the bottom of the card; shows its state and allows one-click changes. */
function rootConfigRow(onChanged) {
  const value = document.createElement("span");
  const root = getConfiguredRoot();
  value.textContent = root || "(not configured)";
  value.style.color = root ? "#d4d4d4" : "#d29922";

  const action = document.createElement("span");
  action.textContent = root ? "[Edit]" : "[Settings]";
  Object.assign(action.style, {
    color: LINK_COLOR,
    cursor: "pointer",
    flex: "0 0 auto",
  });
  action.onclick = (ev) => {
    ev.stopPropagation();
    const input = prompt(
      `Project root for ${location.origin} (absolute disk path):`,
      getConfiguredRoot() || "",
    );
    if (input === null) return;
    setProjectRoot(input.trim().replace(/\/+$/, ""));
    onChanged(); // Rerender in place so location rows use the new root.
  };

  return row("Project root", value, action);
}

// Remember the last inspection so configuration changes can rerender the card in place.
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

  // Header: element tag + close button
  const head = document.createElement("div");
  Object.assign(head.style, {
    display: "flex",
    justifyContent: "space-between",
    // With many class names the title wraps; keep ✕ on the first line rather than centered vertically.
    alignItems: "flex-start",
    gap: "12px",
    marginBottom: "6px",
    paddingBottom: "6px",
    borderBottom: "1px solid #3a3a3a",
  });
  const title = document.createElement("span");
  // SVG className is SVGAnimatedString, not a string, so use getAttribute.
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
    // minWidth: 0 lets a flex item wrap; otherwise long class names exceed the card's maxWidth.
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
      warn.textContent = `⚠ This element has no Fiber; the following information comes from ancestor ${r.ancestorHops} level(s) up`;
      Object.assign(warn.style, { color: "#d29922", marginBottom: "4px" });
      card.append(warn);
    }

    const positions = collectPositions(r.fullChain, 2);
    if (!positions.length) {
      const none = document.createElement("div");
      none.textContent = `⚠ Location information is unavailable: ${r.strategy}`;
      none.style.color = "#d29922";
      card.append(none);
    } else {
      const labels = ["Current element", "Parent"];
      positions.forEach((entry, i) => {
        const link = document.createElement("span");
        fillPositionLink(link, entry);
        const who = document.createElement("span");
        who.textContent = describeNode(entry);
        Object.assign(who.style, { color: "#7d8590", flex: "0 0 auto" });
        card.append(row(labels[i] ?? `${i} level(s) up`, link, who));
      });
    }

    card.append(
      row(
        "Component chain",
        (() => {
          const s = document.createElement("span");
          // componentChain is innermost-first. Take the nearest five levels, then reverse them into
          // outermost-first breadcrumbs; prefix an ellipsis when the chain is truncated.
          const innermost = r.componentChain.slice(0, 5);
          const shown = innermost.reverse().join(" → ");
          s.textContent = shown
            ? (r.componentChain.length > 5 ? "… → " : "") + shown
            : "(none)";
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
          s.textContent = `${r.reactVersion ?? "version unknown"} · ${r.route}`;
          s.style.color = "#7d8590";
          return s;
        })(),
      ),
    );

    // Every path can use the editor, so always show it.
    card.append(editorRow());
    // Only debugStack needs a project root to infer paths; omit it for debugSource to avoid distraction.
    if (r.route === "debugStack") {
      card.append(rootConfigRow(() => showCard(dom, r)));
    }
  }

  placeNear(card, rect, "below");
}

const isOwnUi = (el) =>
  el === overlay || el === label || el === pinBox || card.contains(el);

/** Full-viewport layers such as modals, portal roots, and page roots block clicks but are never the intended target. */
function isFullscreenLayer(el) {
  const r = el.getBoundingClientRect();
  return (
    r.width >= window.innerWidth * 0.95 && r.height >= window.innerHeight * 0.95
  );
}

/**
 * Find the element an event should truly target. event.target is insufficient when:
 *  1. A fullscreen modal or portal layer covers the element, making target that layer or even <html>.
 *  2. The modal is React-rendered (for example, Chakra or Radix), so target has Fiber but is still wrong.
 *  3. A page mousedown handler replaced the DOM (dropdown toggle or outside-click close) before click fires.
 * Use the full hit stack at the pointer coordinates and select the first element with Fiber that is not fullscreen.
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
  // Prefer a specific element; fall back to the topmost only when every hit is fullscreen.
  return withFiber.find((el) => !isFullscreenLayer(el)) || withFiber[0];
}

// Alt + pointer input is an extension-only gesture, so consume the entire sequence from pointerdown.
// Calling preventDefault only on click is too late because page mousedown handlers may have changed the DOM.
let pendingTarget = null;
for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
  document.addEventListener(
    type,
    (e) => {
      if (!e.altKey) return;
      if (e.target instanceof Node && card.contains(e.target)) return; // Allow interactions inside the card.
      e.preventDefault();
      e.stopPropagation();
      // The DOM is still intact; save the target for the following click.
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
  if (e.key === "Alt") hideHint(); // Hide only the hover hint; keep pinned cards.
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
    // Card interactions (close button, location links, settings) use their own onclick handlers.
    if (e.target instanceof Node && card.contains(e.target)) return;

    if (!e.altKey) {
      // Close on an outside click without preventing the page's normal click behavior.
      if (card.style.display !== "none") closeCard();
      return;
    }
    e.preventDefault();
    e.stopPropagation();

    // Prefer the target captured at pointerdown before the page could change the DOM.
    const target = pendingTarget || pickTarget(e);
    pendingTarget = null;
    const r = probe(target);
    console.group(
      "%c[source-inspect] Inspection result",
      "color:#4f9cff;font-weight:bold",
    );
    console.log("Target DOM:", target);
    if (target !== e.target) {
      console.log(
        `%c↑ event.target was <${e.target instanceof Element ? e.target.tagName.toLowerCase() : e.target}>; ` +
          "it was affected by a modal layer or DOM change and corrected using pointer coordinates",
        "color:#d29922",
      );
    }
    if (!r.ok) {
      console.warn(r.reason);
    } else {
      console.log(
        "React version:",
        r.reactVersion ?? "(unavailable; install React DevTools)",
      );
      console.log("Fiber attachment key:", r.fiberKey);
      console.log("%cResolution path: " + r.strategy, "color:#e5c07b");
      if (r.ancestorHops > 0)
        console.warn(
          `The clicked target has no Fiber; using ancestor ${r.ancestorHops} level(s) up:`,
          r.ancestorNode,
        );
      console.log("Resolved target:", r.target ?? "(none)");
      console.log("Owner component:", r.owner ?? "(none)");
      console.log("Component chain (inner to outer):", r.componentChain);
      console.log("Node props:", r.props);
      console.log("Full raw Fiber chain:", r.fullChain);
    }
    console.groupEnd();

    // Do not open the editor directly. Pin a card and let its location links choose the target level.
    hideHint();
    showCard(target, r);
  },
  true,
);

console.log(
  "%c[source-inspect] Probe injected. Alt+move to inspect, Alt+click to pin a card, click a blue location to open the editor, Esc to close.",
  "color:#4f9cff",
);
