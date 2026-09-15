'use strict';
const { app, BrowserWindow, Menu, shell, session, ipcMain, dialog, net } = require('electron');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');
const store = require('./config-store');
const core = require('./core-manager');
const { stopProcess } = require('./dsh-launcher');
const terminal = require('./terminal');
const pluginStore = require('./plugin-store');

// 单实例锁：避免两个实例同时写同一套 profile
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let mainWindow = null;
let kernelProc = null;
let kernelStarting = null;

if (app.getFileIcon) { /* noop */ }
app.setAppUserModelId('ai.deepseek.dshdesktop');

function isLoopbackUrl(u) {
  try {
    const url = new URL(u);
    return ['http:', 'https:'].includes(url.protocol) &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  } catch { return false; }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 840,
    backgroundColor: '#111318',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      // 渲染进程加固三件套
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // 导航白名单：主窗口只能访问回环地址与本地页面；外链仅允许 http(s) 交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url) && !isLoopbackUrl(url)) {
      shell.openExternal(url); // 只放行 http(s)，绝不放行 file:// 等于任意程序执行
    }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!isLoopbackUrl(url) && !url.startsWith('file://')) e.preventDefault();
  });
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, cb) => cb({}));
  mainWindow.on('closed', () => { mainWindow = null; });
}

// 重启内核：完整停掉再拉起（UI「重启内核」按钮 / 菜单用）
async function restartKernel() {
  try {
    if (kernelProc) { const old = kernelProc; kernelProc = null; await stopProcess(old); }
    const r = await startKernel();
    return { ok: true, url: r.url, version: r.version };
  } catch (err) { return { ok: false, error: err.message }; }
}

function buildMenu() {
  const template = [
    {
      label: '内核',
      submenu: [
        { label: '内核管理', accelerator: 'CmdOrCtrl+K', click: () => send('ui:navigate', 'kernel') },
        { label: '重新连接内核', click: () => startKernel() },
        { label: '重启内核', click: () => restartKernel() },
        { type: 'separator' },
        { label: '退出', role: 'quit' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '内置终端', accelerator: 'CmdOrCtrl+`', click: () => send('ui:navigate', 'terminal') },
        { label: '重新加载', role: 'reload' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function send(ch, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, ...args);
}

// 首次启动自动创建默认工作区
function ensureWorkspace() {
  store.ensureDirs();
  const ws = store.paths.workspace();
  const readme = path.join(ws, 'README.txt');
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme, '这是 DSH Desktop 的默认工作区。\n');
  }
}

// 启动即尝试拉起内核；先停掉旧内核进程，防止重连时泄漏（旧内核占着端口/文件）
async function startKernel() {
  if (kernelStarting) return kernelStarting;
  kernelStarting = (async () => {
    send('kernel:status', { state: 'starting' });
    try {
      if (kernelProc) { const old = kernelProc; kernelProc = null; await stopProcess(old); }
      const { proc, url, version } = await core.startCurrent();
      await primeAuthCookie(url);
      kernelProc = proc;
      attachSupervisor(proc, version);
      proc.on('exit', () => { if (kernelProc === proc) { kernelProc = null; } });
      send('kernel:status', { state: 'ready', url, version });
      return { url, version };
    } catch (err) {
      // 启动失败：交给监督器自动回滚到最近一份可用的其他快照
      supervisorRecover(err).catch(() => {});
      send('kernel:status', { state: 'error', message: err.message, version: err.version });
      throw err;
    } finally {
      kernelStarting = null;
    }
  })();
  return kernelStarting;
}

// ---------- 内核监督器 ----------
// 崩溃自愈策略：内核意外退出 → 原地重启（最多 2 次，指数退避）；
// 仍起不来 → 自动切到最近一份 ready 的其他快照（回滚），并通知 UI。
let quitting = false;
let supervising = false;

function attachSupervisor(proc, version) {
  proc.on('exit', (code) => {
    if (quitting || supervising) return;
    if (kernelProc !== proc) return; // 已被主动 stop/替换（切换、重连）
    kernelProc = null;
    // 正常退出码 0 视为人为停止，不自动拉起
    if (code === 0) { send('kernel:status', { state: 'exited' }); return; }
    send('kernel:status', { state: 'crashed', version, code });
    supervisorRecover({ version }).catch(() => {});
  });
}

async function supervisorRecover(failure) {
  if (supervising || quitting) return;
  supervising = true;
  const failedVersion = failure.version || store.getConfig().kernelVersion;
  try {
    // 第一优先：原地重启当前版本（配置/hotfix 类的瞬时崩溃重来一次就好）
    for (let attempt = 1; attempt <= 2; attempt++) {
      send('kernel:status', { state: 'recovering', attempt, version: failedVersion });
      await new Promise((r) => setTimeout(r, 1500 * attempt));
      try {
        if (kernelProc) { const old = kernelProc; kernelProc = null; await stopProcess(old); }
        const { proc, url, version } = await core.startCurrent();
        await primeAuthCookie(url);
        kernelProc = proc;
        attachSupervisor(proc, version);
        proc.on('exit', () => { if (kernelProc === proc) kernelProc = null; });
        send('kernel:status', { state: 'ready', url, version, recovered: true });
        return;
      } catch { /* 再试 */ }
    }
    // 第二优先：回滚到最近一份 ready 的其他快照
    const candidates = core.rollbackCandidates().filter((v) => v !== failedVersion);
    for (const v of candidates) {
      try {
        send('kernel:status', { state: 'rolling_back', to: v, from: failedVersion });
        if (kernelProc) { const old = kernelProc; kernelProc = null; await stopProcess(old); }
        const { proc, url } = await core.switchKernel(v);
        await primeAuthCookie(url);
        kernelProc = proc;
        attachSupervisor(proc, v);
        proc.on('exit', () => { if (kernelProc === proc) kernelProc = null; });
        send('kernel:status', { state: 'ready', url, version: v, rolledBack: true, from: failedVersion });
        return;
      } catch { /* 试下一个候选 */ }
    }
    send('kernel:status', { state: 'down', message: '自动恢复失败：没有可用的快照，请在内核管理里安装', version: failedVersion });
  } finally {
    supervising = false;
  }
}

// dsh 的鉴权 cookie 是 SameSite=Strict，而宿主页(file://)与 iframe(http://127.0.0.1) 跨站，
// iframe 导航里该 cookie 会被拦 → 白屏 "authentication required"。
// 先在主进程取回 303 的 Set-Cookie，以 no_restriction 写进会话，iframe 即可携带。
// 用 node:http 而非 net.request：后者 redirect:'manual' 会直接报 "Redirect was cancelled"。
async function primeAuthCookie(pageUrl) {
  const u = new URL(pageUrl);
  return new Promise((resolve, reject) => {
    const req = http.get({ host: u.hostname, port: u.port, path: u.pathname + u.search }, (res) => {
      res.resume(); // 不消费 body 会阻塞 socket 释放
      const raw = res.headers['set-cookie'] || [];
      Promise.all(raw.map((c) => new Promise((done) => {
        const pair = c.split(';')[0];
        const eq = pair.indexOf('=');
        if (eq <= 0) return done();
        session.defaultSession.cookies.set({
          url: `http://127.0.0.1:${u.port}`,
          name: pair.slice(0, eq),
          value: pair.slice(eq + 1),
          sameSite: 'no_restriction',
        }).then(done, done);
      }))).then(resolve, reject);
    });
    req.on('error', reject);
  });
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('kernel:list', () => core.listSnapshots());
  ipcMain.handle('kernel:registry', async (_e, limitKBps) => core.fetchRegistryMeta('@deepseek-ai/dsh', limitKBps));
  ipcMain.handle('kernel:install', async (_e, version) => {
    try {
      const s = await core.installSnapshot(version, { onProgress: (m) => send('kernel:progress', m) });
      return { ok: true, snapshot: s };
    } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('kernel:switch', async (_e, version) => {
    try {
      if (kernelProc) { const old = kernelProc; kernelProc = null; await stopProcess(old); }
      const { proc, url } = await core.switchKernel(version, { onEvent: (m) => send('kernel:progress', m) });
      await primeAuthCookie(url);
      kernelProc = proc;
      attachSupervisor(proc, version);
      proc.on('exit', () => { if (kernelProc === proc) kernelProc = null; });
      terminal.writeShims();
      return { ok: true, url, version };
    } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('kernel:rollbackCandidates', () => core.rollbackCandidates());
  ipcMain.handle('kernel:delete', (_e, version) => {
    try { return core.deleteSnapshot(version); }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('kernel:start', () => startKernel().then(r => ({ ok: true, ...r })).catch(e => ({ ok: false, error: e.message })));
  ipcMain.handle('kernel:restart', () => restartKernel());
  ipcMain.handle('kernel:webUrl', async () => {
    try { const r = await startKernel(); return { ok: true, url: r.url, version: r.version }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('config:get', () => ({
    ...store.getConfig(),
    paths: store.paths.root(),
    kernelDir: store.paths.coreDir(),
    pluginHome: store.paths.dshHome(),
    browserKernel: `Chromium ${process.versions.chrome}（Electron ${process.versions.electron} 内置，随包分发，不依赖系统浏览器）`,
    nodeRuntime: `Node ${process.versions.node}（Electron 内置，子进程以 ELECTRON_RUN_AS_NODE 复用）`,
  }));
  ipcMain.handle('config:set', (_e, patch) => {
    if (patch && 'keepSnapshots' in patch) {
      patch = { ...patch, keepSnapshots: Math.max(store.MIN_KEEP_SNAPSHOTS, Number(patch.keepSnapshots) || store.DEFAULT_KEEP_SNAPSHOTS) };
    }
    return store.setConfig(patch);
  });
  // 内核目录 / 插件主目录迁移：先停内核再搬，完成后原样重启
  ipcMain.handle('settings:relocate', async (_e, kind, newPath) => {
    try {
      if (!['core', 'dshHome'].includes(kind)) throw new Error('未知目录类型');
      const wasRunning = !!kernelProc;
      if (kernelProc) { const old = kernelProc; kernelProc = null; await stopProcess(old); }
      const r = store.relocate(kind, newPath);
      if (wasRunning) startKernel().catch(() => {});
      return r;
    } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('settings:pickDir', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('shell:detect', () => terminal.detectShell());
  ipcMain.handle('terminal:create', async (_e, { cols, rows }) => {
    try {
      const term = terminal.createSession(cols, rows);
      const id = 't' + Date.now();
      term.onData((d) => send('terminal:data:' + id, d));
      term.onExit(({ exitCode }) => send('terminal:exit:' + id, exitCode));
      sessions.set(id, term);
      return { ok: true, id };
    } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.on('terminal:input', (_e, { id, data }) => { sessions.get(id)?.write(data); });
  ipcMain.on('terminal:resize', (_e, { id, cols, rows }) => { sessions.get(id)?.resize(cols, rows); });
  ipcMain.on('terminal:dispose', (_e, { id }) => {
    const t = sessions.get(id);
    if (t) { try { t.kill(); } catch {} sessions.delete(id); }
  });

  // app:openPath 只允许打开 userData 目录内的路径
  ipcMain.handle('app:openPath', async (_e, p) => {
    const root = store.paths.root();
    const resolved = path.resolve(p);
    if (!resolved.startsWith(root)) return { ok: false, error: '只允许打开数据目录内的路径' };
    await shell.openPath(resolved);
    return { ok: true };
  });

  // 插件商店
  ipcMain.handle('plugins:installed', (_e, profile) => pluginStore.listInstalled(profile));
  ipcMain.handle('plugins:catalog', (_e, limitKBps) => pluginStore.catalog(limitKBps));
  ipcMain.handle('plugins:add', async (_e, spec, profile, limitKBps) => {
    const r = await pluginStore.add(spec, profile, {
      limitKBps: Number(limitKBps) || 0,
      onProgress: (m) => send('plugins:progress', m),
    });
    return r;
  });
  ipcMain.handle('plugins:remove', (_e, name, profile) => pluginStore.remove(name, profile));
  ipcMain.handle('plugins:catalogAdd', (_e, name, desc) => pluginStore.addToCatalog(name, desc));
  ipcMain.handle('plugins:catalogRemove', (_e, name) => pluginStore.removeFromCatalog(name));
}

const sessions = new Map();

app.whenReady().then(async () => {
  ensureWorkspace();
  registerIpc();
  buildMenu();
  createWindow();
  // 启动即尝试拉起内核；内核缺失时启动页会给出「安装内核」按钮（renderer 处理 KERNEL_NOT_INSTALLED）
  startKernel().catch(() => {});
});

app.on('second-instance', () => {
  if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
});

app.on('before-quit', () => { quitting = true; });
app.on('before-quit', async () => {
  for (const t of sessions.values()) { try { t.kill(); } catch {} }
  if (kernelProc) await stopProcess(kernelProc);
});

app.on('window-all-closed', () => app.quit());
