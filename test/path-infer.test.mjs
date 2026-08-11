// 从 content.js 里抽出路径推断逻辑做验证（保持实现一致，改动时两边都要同步）
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
  if (fromFs) return { path: fromFs, via: 'Vite /@fs/ 前缀' };
  if (fileNameLiteral) return { path: fileNameLiteral, via: 'fileName 字面量' };
  if (source && looksLikeDiskPath(source, moduleUrl)) return { path: source, via: 'sources 本身是绝对路径' };
  if (map.sourceRoot && source) {
    const joined = map.sourceRoot.replace(/\/+$/, '') + '/' + normalizeSourcePath(source);
    if (joined.startsWith('/') || /^[A-Za-z]:[\\/]/.test(joined)) return { path: joined, via: 'sourceRoot + sources' };
  }
  if (!root) return null;
  const fromUrl = pathFromModuleUrl(moduleUrl, root);
  if (fromUrl && (!source || basename(fromUrl) === basename(source))) return { path: fromUrl, via: '项目根 + 模块 URL 路径' };
  if (source) return { path: root.replace(/\/+$/, '') + '/' + normalizeSourcePath(source), via: '项目根 + sources' };
  return null;
}

const SODEX = '/Users/luigi_li/codespaces/sodex-next';
const cases = [
  {
    name: 'sodex-next 实际形态：plugin-react v6 无 fileName，sources 只有裸文件名，必须靠模块 URL 才能区分 151 个 index.tsx',
    input: { fileNameLiteral: null, map: {}, source: 'index.tsx', moduleUrl: 'http://localhost:3000/src/features/ticker/FavoriteTickerBar/index.tsx?t=1735', root: SODEX },
    expect: `${SODEX}/src/features/ticker/FavoriteTickerBar/index.tsx`,
    expectVia: '项目根 + 模块 URL 路径',
  },
  {
    name: '没配项目根时必须显性失败，不能猜一个错路径出来',
    input: { fileNameLiteral: null, map: {}, source: 'index.tsx', moduleUrl: 'http://localhost:3000/src/a/index.tsx', root: null },
    expect: null,
  },
  {
    name: 'plugin-react v5 有 fileName 字面量时优先用它，零配置',
    input: { fileNameLiteral: '/Users/x/demo/src/App.tsx', map: {}, source: 'App.tsx', moduleUrl: 'http://localhost:5173/src/App.tsx', root: null },
    expect: '/Users/x/demo/src/App.tsx',
    expectVia: 'fileName 字面量',
  },
  {
    name: '/@fs/ 前缀模块（monorepo 外部文件）自带绝对路径，不需要项目根',
    input: { fileNameLiteral: null, map: {}, source: 'Btn.tsx', moduleUrl: 'http://localhost:3000/@fs/Users/luigi_li/shared-ui/src/Btn.tsx?v=abc', root: null },
    expect: '/Users/luigi_li/shared-ui/src/Btn.tsx',
    expectVia: 'Vite /@fs/ 前缀',
  },
  {
    name: 'webpack 单 bundle：URL 文件名(main.js)与源文件名(index.tsx)不符，不能拿 URL 路径硬拼，退回 sources',
    input: { fileNameLiteral: null, map: {}, source: 'webpack:///./src/pages/index.tsx', moduleUrl: 'http://localhost:8080/static/js/main.js', root: '/Users/x/wp' },
    expect: '/Users/x/wp/src/pages/index.tsx',
    expectVia: '项目根 + sources',
  },
  {
    name: 'sources 本身是绝对路径时直接用（部分 SWC / esbuild 配置会这样输出）',
    input: { fileNameLiteral: null, map: {}, source: '/Users/x/p/src/index.tsx', moduleUrl: 'http://localhost:3000/src/index.tsx', root: null },
    expect: '/Users/x/p/src/index.tsx',
    expectVia: 'sources 本身是绝对路径',
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
  if (!ok) console.log(`    期望 ${c.expect} (${c.expectVia ?? '-'})\n    实际 ${got} (${r?.via ?? '-'})`);
}
console.log(`\n${pass}/${cases.length} 通过`);
process.exit(pass === cases.length ? 0 : 1);
