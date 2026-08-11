// One-off diagnosis: paste this into the target project's Console to print all path-inference inputs.
(async () => {
  const FRAME_RE = /at\s+(?:async\s+)?(?:(.+?)\s+\()?(\S+?):(\d+):(\d+)\)?$/;
  const isFw = (u) => /\/node_modules\/|jsx-dev-runtime|react-dom|\/@react-refresh|\/@vite\//.test(u);

  // Find the first page element that exposes a JSX call site.
  let callSite = null;
  for (const el of document.querySelectorAll('*')) {
    let k = null;
    for (const key in el) if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) { k = key; break; }
    if (!k) continue;
    let f = el[k];
    while (f && !callSite) {
      if (f._debugStack) {
        const raw = String(f._debugStack.stack || f._debugStack);
        for (const line of raw.split('\n')) {
          const m = FRAME_RE.exec(line.trim());
          if (m && !isFw(m[2])) { callSite = { url: m[2], line: +m[3], column: +m[4], fn: m[1] }; break; }
        }
      }
      if (f._debugSource) console.log('Unexpected _debugSource (React <=18 path):', f._debugSource);
      f = f.return;
    }
    if (callSite) break;
  }

  console.group('%c[diagnose]', 'color:#4f9cff;font-weight:bold');
  console.log('Page origin:', location.origin);

  const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  let ver = null;
  if (hook && hook.renderers) for (const r of hook.renderers.values()) if (r.version) ver = r.version;
  console.log('React version:', ver ?? '(unavailable; install React DevTools)');

  if (!callSite) {
    console.error('No element with _debugStack was found');
    console.groupEnd();
    return;
  }
  console.log('Module URL:', callSite.url, `→ ${callSite.line}:${callSite.column}  (fn: ${callSite.fn})`);

  const text = await (await fetch(callSite.url, { credentials: 'omit' })).text();
  console.log('Module text length:', text.length);

  const fn = /fileName:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  console.log('fileName literal:', fn ? fn[1] : '❌ absent (this explains the current error)');

  const inline = /sourceMappingURL=data:application\/json;(?:charset=[^;]+;)?base64,([A-Za-z0-9+/=]+)/.exec(text);
  const ext = /\/\/[#@]\s*sourceMappingURL=(?!data:)(\S+)/.exec(text);
  let map = null;
  if (inline) {
    console.log('sourcemap: inline base64');
    const bin = atob(inline[1]);
    map = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  } else if (ext) {
    const u = new URL(ext[1], callSite.url).href;
    console.log('Source map: external file', u);
    map = await (await fetch(u, { credentials: 'omit' })).json();
  } else {
    console.error('No source map found');
  }

  if (map) {
    console.log('%c↓ Key fields for inferring an absolute path without configuration', 'color:#e5c07b');
    console.log('sourceRoot:', JSON.stringify(map.sourceRoot));
    console.log('file:', JSON.stringify(map.file));
    console.log('sources (first 5):', JSON.stringify((map.sources || []).slice(0, 5), null, 2));
    console.log('sources count:', (map.sources || []).length);
    console.log('has sourcesContent:', !!(map.sourcesContent && map.sourcesContent.length));
    console.log('Module URL pathname:', new URL(callSite.url).pathname);
  }
  console.groupEnd();
})();
