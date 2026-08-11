// 一次性诊断：粘到目标项目页面的 Console 里执行，输出路径推断需要的全部信息。
(async () => {
  const FRAME_RE = /at\s+(?:async\s+)?(?:(.+?)\s+\()?(\S+?):(\d+):(\d+)\)?$/;
  const isFw = (u) => /\/node_modules\/|jsx-dev-runtime|react-dom|\/@react-refresh|\/@vite\//.test(u);

  // 找页面上第一个能拿到 JSX 调用点的元素
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
      if (f._debugSource) console.log('意外发现 _debugSource（React <=18 路径）:', f._debugSource);
      f = f.return;
    }
    if (callSite) break;
  }

  console.group('%c[diagnose]', 'color:#4f9cff;font-weight:bold');
  console.log('页面 origin:', location.origin);

  const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  let ver = null;
  if (hook && hook.renderers) for (const r of hook.renderers.values()) if (r.version) ver = r.version;
  console.log('React 版本:', ver ?? '(读不到，需装 React DevTools)');

  if (!callSite) {
    console.error('找不到任何带 _debugStack 的元素');
    console.groupEnd();
    return;
  }
  console.log('模块 URL:', callSite.url, `→ ${callSite.line}:${callSite.column}  (fn: ${callSite.fn})`);

  const text = await (await fetch(callSite.url, { credentials: 'omit' })).text();
  console.log('模块文本长度:', text.length);

  const fn = /fileName:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  console.log('fileName 字面量:', fn ? fn[1] : '❌ 没有（这就是当前报错的原因）');

  const inline = /sourceMappingURL=data:application\/json;(?:charset=[^;]+;)?base64,([A-Za-z0-9+/=]+)/.exec(text);
  const ext = /\/\/[#@]\s*sourceMappingURL=(?!data:)(\S+)/.exec(text);
  let map = null;
  if (inline) {
    console.log('sourcemap: inline base64');
    const bin = atob(inline[1]);
    map = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  } else if (ext) {
    const u = new URL(ext[1], callSite.url).href;
    console.log('sourcemap: 外部文件', u);
    map = await (await fetch(u, { credentials: 'omit' })).json();
  } else {
    console.error('没有 sourcemap');
  }

  if (map) {
    console.log('%c↓ 关键：这几个字段决定能不能零配置推出绝对路径', 'color:#e5c07b');
    console.log('sourceRoot:', JSON.stringify(map.sourceRoot));
    console.log('file:', JSON.stringify(map.file));
    console.log('sources (前 5 条):', JSON.stringify((map.sources || []).slice(0, 5), null, 2));
    console.log('sources 总数:', (map.sources || []).length);
    console.log('有 sourcesContent:', !!(map.sourcesContent && map.sourcesContent.length));
    console.log('模块 URL 的 pathname:', new URL(callSite.url).pathname);
  }
  console.groupEnd();
})();
