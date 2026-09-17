'use strict';
// v0.3.0 安全加固补丁（幂等：每步先检查是否已应用）
const fs = require('node:fs');
const path = require('node:path');
let applied = [], skipped = [];

function patch(file, find, replace, label) {
  const p = path.join(__dirname, '..', 'src', 'main', file);
  let s = fs.readFileSync(p, 'utf8').split('\r\n').join('\n'); // git 检出为 CRLF，统一按 LF 匹配
  if (s.includes(replace)) { skipped.push(label); return; }
  if (!s.includes(find)) throw new Error(`[${label}] 找不到锚点: ${find.slice(0, 60)}...`);
  s = s.replace(find, replace);
  fs.writeFileSync(p, s);
  applied.push(label);
}

// 1. dsh-launcher: buildChildEnv 剥离 NODE_OPTIONS
patch('dsh-launcher.js',
`  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    DSH_HOME: dshHome,
    PATH: \`\${pathHead}\${path.delimiter}\${process.env.PATH || ''}\`,
  };
}`,
`  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    DSH_HOME: dshHome,
    PATH: \`\${pathHead}\${path.delimiter}\${process.env.PATH || ''}\`,
  };
  // 环境滤毒：NODE_OPTIONS 能让 run-as-node 子进程加载任意 JS（--require）
  delete env.NODE_OPTIONS;
  return env;
}`, 'launcher-NODE_OPTIONS');

// 2. core-manager: nodeEnv 剥离 NODE_OPTIONS
patch('core-manager.js',
`function nodeEnv() { return { ...process.env, ELECTRON_RUN_AS_NODE: '1' }; }`,
`function nodeEnv() {
  // 与 buildChildEnv 同源滤毒：剥离 NODE_OPTIONS 防注入
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  delete env.NODE_OPTIONS;
  return env;
}`, 'core-nodeEnv');

// 3. core-manager: CONNECT 白名单仅 443
patch('core-manager.js',
`  server.on('connect', (req, clientSocket, head) => {
    const [host, port] = req.url.split(':');
    const upstream = net.connect({ host, port: Number(port) || 443 }, () => {`,
`  server.on('connect', (req, clientSocket, head) => {
    const [host, port] = req.url.split(':');
    // CONNECT 白名单：只放行 443（npm registry 下载通道），防本机进程用作内网跳板
    if (Number(port) !== 443 || !/^[A-Za-z0-9.-]+$/.test(host || '')) {
      clientSocket.write('HTTP/1.1 403 Forbidden\\r\\n\\r\\n');
      clientSocket.destroy();
      return;
    }
    const upstream = net.connect({ host, port: Number(port) || 443 }, () => {`, 'proxy-CONNECT-443');

// 4. index.js: config:set 白名单
patch('index.js',
`  ipcMain.handle('config:set', (_e, patch) => {
    if (patch && 'keepSnapshots' in patch) {
      patch = { ...patch, keepSnapshots: Math.max(store.MIN_KEEP_SNAPSHOTS, Number(patch.keepSnapshots) || store.DEFAULT_KEEP_SNAPSHOTS) };
    }
    return store.setConfig(patch);
  });`,
`  // config:set 白名单：渲染层只能改这几个键（shell/数据目录指针等绝不暴露）
  const CONFIG_WRITABLE_KEYS = new Set(['keepSnapshots', 'rateLimitKBps']);
  ipcMain.handle('config:set', (_e, patch) => {
    if (!patch || typeof patch !== 'object') return store.getConfig();
    const safe = {};
    for (const k of Object.keys(patch)) {
      if (CONFIG_WRITABLE_KEYS.has(k)) safe[k] = patch[k];
    }
    if ('keepSnapshots' in safe) {
      safe.keepSnapshots = Math.max(store.MIN_KEEP_SNAPSHOTS, Number(safe.keepSnapshots) || store.DEFAULT_KEEP_SNAPSHOTS);
    }
    return store.setConfig(safe);
  });`, 'config-set-whitelist');

// 5. index.js: permission 全拒 + webview 拦截
patch('index.js',
`  mainWindow.webContents.session.webRequest.onHeadersReceived((details, cb) => cb({}));
  mainWindow.on('closed', () => { mainWindow = null; });`,
`  // 权限请求一律拒绝：应用不需要 geolocation/notifications/media 等任何 Web 权限
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  // 即使将来误开 webviewTag，也不允许任何 webview 挂载（iframe 承载已够用）
  mainWindow.webContents.on('will-attach-webview', (e, webPreferences, params) => {
    e.preventDefault();
    webPreferences = null; params = null;
  });
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, cb) => cb({}));
  mainWindow.on('closed', () => { mainWindow = null; });`, 'perm-deny-webview-block');

// 6. index.js: 终端 input 限长 + resize 钳制
patch('index.js',
`  ipcMain.on('terminal:input', (_e, { id, data }) => { sessions.get(id)?.write(data); });
  ipcMain.on('terminal:resize', (_e, { id, cols, rows }) => { sessions.get(id)?.resize(cols, rows); });`,
`  ipcMain.on('terminal:input', (_e, { id, data }) => {
    if (typeof data !== 'string' || data.length > 4096) return;
    sessions.get(id)?.write(data);
  });
  ipcMain.on('terminal:resize', (_e, { id, cols, rows }) => {
    const c = Math.min(Math.max(Number(cols) || 80, 2), 500);
    const r = Math.min(Math.max(Number(rows) || 24, 2), 300);
    sessions.get(id)?.resize(c, r);
  });`, 'terminal-clamps');

// 7. index.js: openPath 大小写归一 + 边界校验
patch('index.js',
`  ipcMain.handle('app:openPath', async (_e, p) => {
    const root = store.paths.root();
    const resolved = path.resolve(p);
    if (!resolved.startsWith(root)) return { ok: false, error: '只允许打开数据目录内的路径' };
    await shell.openPath(resolved);
    return { ok: true };
  });`,
`  ipcMain.handle('app:openPath', async (_e, p) => {
    const root = path.resolve(store.paths.root());
    const resolved = path.resolve(String(p || ''));
    const norm = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);
    const nRoot = norm(root) + path.sep;
    if (norm(resolved) !== norm(root) && !norm(resolved).startsWith(nRoot)) {
      return { ok: false, error: '只允许打开数据目录内的路径' };
    }
    await shell.openPath(resolved);
    return { ok: true };
  });`, 'openPath-normalize');

// 8. renderer: esc() 工具
{
  const p = path.join(__dirname, '..', 'src', 'renderer', 'renderer.js');
  let s = fs.readFileSync(p, 'utf8').split('\r\n').join('\n');
  if (!s.includes('const esc =')) {
    s = s.replace(
`const currentVersion = { value: null };`,
`const currentVersion = { value: null };

// HTML 转义：插件名/版本/描述来自 npm 第三方数据，插值进 innerHTML 前必须过这里
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));`);
    fs.writeFileSync(p, s);
    applied.push('renderer-esc-util');
  } else skipped.push('renderer-esc-util');

  // 9. renderer: 三处模板转义（幂等替换）
  const subs = [
    ['`<td>${p.name}</td><td>${p.version}</td><td><button class="act ghost" data-rm="${p.name}">卸载</button></td>`',
     '`<td>${esc(p.name)}</td><td>${esc(p.version)}</td><td><button class="act ghost" data-rm="${esc(p.name)}">卸载</button></td>`'],
    ['`<td>${item.name}${item.custom',
     '`<td>${esc(item.name)}${item.custom'],
    ['`<td>${s.version}${isCur',
     '`<td>${esc(s.version)}${isCur'],
  ];
  for (const [a, b] of subs) {
    if (s.includes(a)) { s = s.split(a).join(b); applied.push('renderer-esc:' + a.slice(0, 30)); }
    else if (s.includes(b)) skipped.push('renderer-esc:' + a.slice(0, 30));
    else throw new Error('renderer 模板锚点缺失: ' + a.slice(0, 40));
  }
  // data-cat / data-catdel / data-switch / data-del 属性也要转义
  s = s.replace(/data-cat="\$\{item\.name\}"/g, 'data-cat="${esc(item.name)}"')
       .replace(/data-catdel="\$\{item\.name\}"/g, 'data-catdel="${esc(item.name)}"')
       .replace(/data-switch="\$\{s\.version\}"/g, 'data-switch="${esc(s.version)}"')
       .replace(/data-del="\$\{s\.version\}"/g, 'data-del="${esc(s.version)}"')
       .replace(/\$\{esc\(item\.desc \|\| ''\)\}/g, "${esc(item.desc || '')}}".replace('}}','}'));
  fs.writeFileSync(p, s);
}

console.log('已应用:', applied.length, applied);
console.log('已存在跳过:', skipped.length, skipped);
