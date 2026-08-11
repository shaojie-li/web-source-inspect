// Path-inference checks extracted from content.js. Keep this in sync with the implementation.
const basename = (p) => String(p).split(/[\\/]/).pop();

function normalizeSourcePath(source) {
  return source.replace(/^webpack:\/\/\/?/, '').replace(/^[^/]*\/\.\//, '').replace(/^\.\//, '').replace(/^\//, '');
}
function looksLikeDiskPath(candidate, moduleUrl) {
  if (/^[A-Za-z]:[\\/]/.test(candidate)) return true;
  if (!candidate.startsWith('/')) return false;
  const urlPath = new URL(moduleUrl).pathname;
  return candidate.endsWith(urlPath) && candidate.length > urlPath.length;
}
function pathFromModuleUrl(moduleUrl, root) {
  const pathname = new URL(moduleUrl).pathname;
  if (pathname.startsWith('/@fs/')) return pathname.slice('/@fs'.length);
  if (!root) return null;
  return root.replace(/\/+$/, '') + pathname;
}
function inferAbsPath({ fileNameLiteral, map, source, moduleUrl, root }) {
  const fromFs = pathFromModuleUrl(moduleUrl, null);
  if (fromFs) return { path: fromFs, via: 'Vite /@fs/ prefix' };
  if (fileNameLiteral) return { path: fileNameLiteral, via: 'fileName literal' };
  if (source && looksLikeDiskPath(source, moduleUrl)) return { path: source, via: 'absolute source path' };
  if (map.sourceRoot && source) {
    const joined = map.sourceRoot.replace(/\/+$/, '') + '/' + normalizeSourcePath(source);
    if (joined.startsWith('/') || /^[A-Za-z]:[\\/]/.test(joined)) return { path: joined, via: 'sourceRoot + sources' };
  }
  if (!root) return null;
  const fromUrl = pathFromModuleUrl(moduleUrl, root);
  if (fromUrl && (!source || basename(fromUrl) === basename(source))) return { path: fromUrl, via: 'project root + module URL path' };
  if (source) return { path: root.replace(/\/+$/, '') + '/' + normalizeSourcePath(source), via: 'project root + sources' };
  return null;
}

const SODEX = '/Users/luigi_li/codespaces/sodex-next';
const cases = [
  {
    name: 'plugin-react v6 exposes no fileName and bare source names, so the module URL distinguishes 151 index.tsx files',
    input: { fileNameLiteral: null, map: {}, source: 'index.tsx', moduleUrl: 'http://localhost:3000/src/features/ticker/FavoriteTickerBar/index.tsx?t=1735', root: SODEX },
    expect: `${SODEX}/src/features/ticker/FavoriteTickerBar/index.tsx`,
    expectVia: 'project root + module URL path',
  },
  {
    name: 'fails explicitly without a project root instead of guessing an incorrect path',
    input: { fileNameLiteral: null, map: {}, source: 'index.tsx', moduleUrl: 'http://localhost:3000/src/a/index.tsx', root: null },
    expect: null,
  },
  {
    name: 'prefers a plugin-react v5 fileName literal with no configuration',
    input: { fileNameLiteral: '/Users/x/demo/src/App.tsx', map: {}, source: 'App.tsx', moduleUrl: 'http://localhost:5173/src/App.tsx', root: null },
    expect: '/Users/x/demo/src/App.tsx',
    expectVia: 'fileName literal',
  },
  {
    name: 'an /@fs/ module outside a monorepo has its absolute path and needs no project root',
    input: { fileNameLiteral: null, map: {}, source: 'Btn.tsx', moduleUrl: 'http://localhost:3000/@fs/Users/luigi_li/shared-ui/src/Btn.tsx?v=abc', root: null },
    expect: '/Users/luigi_li/shared-ui/src/Btn.tsx',
    expectVia: 'Vite /@fs/ prefix',
  },
  {
    name: 'a Webpack single bundle falls back to sources when main.js does not match index.tsx',
    input: { fileNameLiteral: null, map: {}, source: 'webpack:///./src/pages/index.tsx', moduleUrl: 'http://localhost:8080/static/js/main.js', root: '/Users/x/wp' },
    expect: '/Users/x/wp/src/pages/index.tsx',
    expectVia: 'project root + sources',
  },
  {
    name: 'uses an absolute sources entry directly, as emitted by some SWC and esbuild configurations',
    input: { fileNameLiteral: null, map: {}, source: '/Users/x/p/src/index.tsx', moduleUrl: 'http://localhost:3000/src/index.tsx', root: null },
    expect: '/Users/x/p/src/index.tsx',
    expectVia: 'absolute source path',
  },
];

let pass = 0;
for (const c of cases) {
  const r = inferAbsPath(c.input);
  const got = r ? r.path : null;
  const viaOk = !c.expectVia || (r && r.via === c.expectVia);
  const ok = got === c.expect && viaOk;
  if (ok) pass++;
  console.log(`${ok ? '✓' : '✗'} ${c.name}`);
  if (!ok) console.log(`    expected ${c.expect} (${c.expectVia ?? '-'})\n    actual ${got} (${r?.via ?? '-'})`);
}
console.log(`\n${pass}/${cases.length} passed`);
process.exit(pass === cases.length ? 0 : 1);
