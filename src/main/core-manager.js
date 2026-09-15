'use strict';
// 内核（dsh 本体）管理：查询 → 暂存安装 → 校验入口 → 预启动冒烟 → 提升为快照 → 切换。
// 核心不变量：只有新内核真的启动并通过 HTTP 就绪探测，才允许写入配置替换当前内核。
// 任何一步失败，暂存目录被删除，当前内核分毫未动。
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { net } = require('electron');
const store = require('./config-store');
const { launchKernel, waitUntilServing, stopProcess } = require('./dsh-launcher');

// 版本号白名单：拼进 pnpm 参数与路径前校验（防参数注入与路径穿越）
const VERSION_RE = /^\d+\.\d+\.\d+(-[A-Za-z0-9.+-]+)?$/;
const PKG_RE = /^(@[A-Za-z0-9-][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertVersion(v) {
  if (!VERSION_RE.test(String(v))) throw new Error(`非法版本号: ${v}`);
  return String(v);
}
function assertPkg(name) {
  if (!PKG_RE.test(String(name))) throw new Error(`非法包名: ${name}`);
  return String(name);
}

// Electron 二进制当作纯 Node 用（省掉打包一套 ~50MB 的 Node 运行时）
function nodeBinary() { return process.execPath; }
function nodeEnv() { return { ...process.env, ELECTRON_RUN_AS_NODE: '1' }; }

function bundledPnpmDir() {
  return path.resolve(__dirname, '..', '..', 'node_modules', 'pnpm');
}

// 远端元数据：npm registry 的版本列表
async function fetchRegistryMeta(name, limitKBps = 0) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name).replace('%40', '@')}`;
  const res = await netFetchJson(url, limitKBps);
  const versions = Object.keys(res.versions || {}).filter(v => VERSION_RE.test(v));
  return { latest: res['dist-tags'] && res['dist-tags'].latest, versions };
}

function netFetchJson(url, limitKBps) {
  return new Promise((resolve, reject) => {
    const req = net.request(url);
    const timer = setTimeout(() => { req.destroy(); reject(new Error('registry 请求超时')); }, 30000);
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.end();
  });
}

// 双通道限速之一：本地 CONNECT 隧道代理。每通道各一个，互不影响。
function startRateLimitProxy(limitKBps) {
  if (!limitKBps || limitKBps <= 0) return { url: null, close() {} };
  let budget = limitKBps * 1024;
  setInterval(() => { budget = limitKBps * 1024; }, 1000).unref();
  const server = http.createServer((req, res) => res.destroy());
  server.on('connect', (req, clientSocket, head) => {
    const [host, port] = req.url.split(':');
    const upstream = net.connect({ host, port: Number(port) || 443 }, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      pump(upstream, clientSocket);
      pump(clientSocket, upstream);
    });
    function pump(from, to) {
      from.on('data', (chunk) => {
        const take = Math.min(chunk.length, Math.max(budget, 0));
        budget -= take;
        if (take < chunk.length) from.pause(), setTimeout(() => from.resume(), 1000);
        if (take > 0 && !to.write(chunk.subarray(0, take))) from.pause();
        if (take > 0) to.once('drain', () => from.resume());
      });
      from.on('end', () => to.end());
      from.on('error', () => { clientSocket.destroy(); upstream.destroy(); });
    }
    upstream.on('error', () => clientSocket.destroy());
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}`,
      close: () => server.close(),
    }));
  });
}

function runNode(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(nodeBinary(), args, {
      ...opts,
      env: { ...nodeEnv(), ...(opts.env || {}) },
      windowsHide: true,
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; if (opts.onStdout) opts.onStdout(d); });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}\n${err || out}`))));
  });
}

// .npmrc 模板：pnpm 10 放行构建脚本 + 镜像 + hoisted 缩短路径（对抗 MAX_PATH 260）
function writePnpmNpmrc(dir, proxyUrl) {
  const lines = [
    'dangerously-allow-all-builds=true',
    'node-linker=hoisted',
    'node-pty_binary_host_mirror=https://registry.npmmirror.com/-/binary/node-pty',
    'sharp_binary_host=https://registry.npmmirror.com/-/binary/sharp',
    'sharp_libvips_binary_host=https://registry.npmmirror.com/-/binary/sharp-libvips',
  ];
  if (proxyUrl) lines.push(`proxy=${proxyUrl}`, `https-proxy=${proxyUrl}`);
  fs.writeFileSync(path.join(dir, '.npmrc'), lines.join('\n') + '\n');
}

function snapshotDir(version) {
  assertVersion(version);
  return path.join(store.paths.snapshotsDir(), version);
}

function snapshotStatus(version) {
  const dir = snapshotDir(version);
  const entry = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  return {
    version,
    dir,
    installed: fs.existsSync(entry),
    ready: fs.existsSync(path.join(dir, '.ready')),
  };
}

function listSnapshots() {
  const dir = store.paths.snapshotsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((v) => VERSION_RE.test(v))
    .map(snapshotStatus)
    .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
}

async function installSnapshot(version, { limitKBps = 0, onProgress } = {}) {
  assertVersion(version);
  if (!store.acquireLock('install:' + version)) throw new Error('另一个安装正在进行（update.lock）');
  const proxy = await startRateLimitProxy(limitKBps);
  try {
    store.ensureDirs();
    const staging = path.join(store.paths.stagingDir(), version);
    await retryFs(fs.rmSync, staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    writePnpmNpmrc(staging, proxy.url);

    const pnpmDir = bundledPnpmDir();
    onProgress && onProgress(`用内置 pnpm 安装 dsh@${version}（约 522 个依赖）...`);
    await runNode([
      path.join(pnpmDir, 'bin', 'pnpm.cjs'),
      'add', `@deepseek-ai/dsh@${version}`, '--save-exact',
    ], { cwd: staging, onStdout: onProgress });

    // 校验入口
    const entry = path.join(staging, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    if (!fs.existsSync(entry)) throw new Error('安装后找不到 dsh 入口 bin.js');
    const pkg = JSON.parse(fs.readFileSync(path.join(staging, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
    if (pkg.version !== version) throw new Error(`版本不匹配: 期望 ${version}，实际 ${pkg.version}`);

    // 预启动冒烟：独立 smoke-home，不污染真实 DSH_HOME。
    // 它只能证明「这个内核能起来」，真正切换仍要能在失败时回滚。
    // AV 对刚写完的 400MB 依赖树可能有数秒的实时扫描窗口（表现为某依赖"消失"/读不到），
    // 快速失败时等一轮再重试一次。
    onProgress && onProgress('预启动冒烟测试...');
    try {
      await smokeStart(staging, onProgress);
    } catch (err) {
      onProgress && onProgress(`冒烟失败（${String(err.message).slice(0, 60)}...），疑似 AV 扫描窗口，5 秒后重试一次`);
      await sleep(5000);
      await smokeStart(staging, onProgress);
    }

    // 提升为快照。Windows 上杀完进程树后 AV/句柄释放可能有延迟：
    // rename 先重试几次，仍锁着就退化为 复制+删除
    const dest = snapshotDir(version);
    await retryFs(fs.rmSync, dest, { recursive: true, force: true });
    await promote(staging, dest);
    fs.writeFileSync(path.join(dest, '.ready'), new Date().toISOString());
    pruneSnapshots();
    return snapshotStatus(version);
  } finally {
    proxy.close();
    store.releaseLock();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Windows 上 AV/索引服务会临时锁住刚写入的大目录树（EPERM/EBUSY/delete-pending）。
// rm/rename 都走这里：短重试，容忍目标已消失。
async function retryFs(fn, ...args) {
  let last;
  for (let i = 0; i < 4; i++) {
    try {
      return fn(...args);
    } catch (err) {
      if (err.code === 'ENOENT') return;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err;
      last = err;
      await sleep(1000 * (i + 1));
    }
  }
  throw last;
}

// staging → snapshots 提升：rename 优先（同盘瞬时），EPERM 重试，最终兜底复制
async function promote(src, dest) {
  for (let i = 0; i < 3; i++) {
    try {
      fs.renameSync(src, dest);
      return;
    } catch (err) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err;
      await sleep(1000 * (i + 1));
    }
  }
  await retryFs(fs.cpSync, src, dest, { recursive: true });
  await retryFs(fs.rmSync, src, { recursive: true, force: true });
}

// 在独立 DSH_HOME 里启动内核并等 HTTP 就绪
async function smokeStart(dir, onProgress) {
  const smokeHome = path.join(store.paths.stagingDir(), 'smoke-home');
  fs.rmSync(smokeHome, { recursive: true, force: true });
  fs.mkdirSync(smokeHome, { recursive: true });
  const entry = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  const proc = launchKernel({ entry, dshHome: smokeHome, cwd: store.paths.workspace() });
  try {
    const url = await waitUntilServing(proc, 90000);
    onProgress && onProgress(`冒烟通过: ${url.replace(/token=[^&]*/, 'token=***')}`);
    return url;
  } finally {
    await stopProcess(proc);
    fs.rmSync(smokeHome, { recursive: true, force: true });
  }
}

// 切换：stop → 启动新快照 → 成功后才写 config（顺序不能反，smoke:switch 验证这条）
async function switchKernel(version, { launchOpts = {}, onEvent } = {}) {
  assertVersion(version);
  const status = snapshotStatus(version);
  if (!status.installed) throw new Error(`快照 ${version} 未安装`);
  const from = store.getConfig().kernelVersion;
  let proc = null;
  try {
    onEvent && onEvent(`启动快照 ${version}...`);
    proc = await launchKernel({
      entry: path.join(status.dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      dshHome: store.paths.dshHome(),
      cwd: store.paths.workspace(),
      ...launchOpts,
    });
    const url = await waitUntilServing(proc, 60000);
    store.setConfig({ kernelVersion: version });
    recordHistory(from, version);
    onEvent && onEvent(`已切换到 ${version}`);
    return { proc, url };
  } catch (err) {
    // 失败自愈：指针不动（还没写），把新内核停掉；若指针已动则写回并重启原内核
    if (proc) await stopProcess(proc);
    const cur = store.getConfig().kernelVersion;
    if (cur === version) {
      store.setConfig({ kernelVersion: from });
      if (from && snapshotStatus(from).installed) {
        onEvent && onEvent(`切换失败，回滚到 ${from}`);
        const back = await startCurrent();
        return { proc: back.proc, url: back.url, rolledBack: true, error: String(err) };
      }
    }
    throw err;
  }
}

async function startCurrent() {
  const version = store.getConfig().kernelVersion || store.DEFAULT_KERNEL_VERSION;
  const status = snapshotStatus(version);
  if (!status.installed) {
    const err = new Error('KERNEL_NOT_INSTALLED');
    err.version = version;
    throw err;
  }
  const proc = launchKernel({
    entry: path.join(status.dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    dshHome: store.paths.dshHome(),
    cwd: store.paths.workspace(),
  });
  const url = await waitUntilServing(proc, 60000);
  return { proc, url, version };
}

function recordHistory(from, to) {
  const m = store.readManifest();
  m.history.unshift({ from, to, at: new Date().toISOString() });
  m.history = m.history.slice(0, 50);
  store.writeManifest(m);
}

// 保留最近 keep 份 ready 快照（keepSnapshots 语义：含当前内核的总保留数，下限 2）。
// 当前内核永远豁免——新装的内核在切换前也不能被清。
function pruneSnapshots() {
  const keep = Math.max(store.MIN_KEEP_SNAPSHOTS, store.getConfig().keepSnapshots ?? store.DEFAULT_KEEP_SNAPSHOTS);
  const cur = store.getConfig().kernelVersion;
  const all = listSnapshots().filter((s) => s.ready);
  for (const s of all.slice(keep)) {
    if (s.version !== cur) fs.rmSync(s.dir, { recursive: true, force: true });
  }
}

// 回滚候选：除当前版本外所有 ready 快照
function rollbackCandidates() {
  const cur = store.getConfig().kernelVersion;
  return listSnapshots().filter((s) => s.ready && s.version !== cur).map((s) => s.version);
}

// 删除快照：当前内核不可删（先切走）；且必须保证删完仍有至少两份 ready
// 快照（当前 + 至少一个回滚目标），否则拒绝。
function deleteSnapshot(version) {
  assertVersion(version);
  const cur = store.getConfig().kernelVersion;
  if (version === cur) throw new Error(`${version} 是当前内核，请先切换到其他版本再删除`);
  const readyCount = listSnapshots().filter((s) => s.ready).length;
  if (readyCount <= store.MIN_KEEP_SNAPSHOTS) {
    throw new Error(`至少要保留 ${store.MIN_KEEP_SNAPSHOTS} 份快照（当前 + 一份可回滚），请先安装其他版本`);
  }
  const dir = snapshotDir(version);
  if (!fs.existsSync(dir)) throw new Error(`快照 ${version} 不存在`);
  fs.rmSync(dir, { recursive: true, force: true });
  const m = store.readManifest();
  m.snapshots = (m.snapshots || []).filter((s) => s.version !== version);
  store.writeManifest(m);
  return { ok: true, deleted: version };
}

module.exports = {
  assertVersion,
  assertPkg,
  writePnpmNpmrc,
  listSnapshots,
  snapshotStatus,
  snapshotDir,
  installSnapshot,
  switchKernel,
  startCurrent,
  pruneSnapshots,
  deleteSnapshot,
  rollbackCandidates,
  fetchRegistryMeta,
  startRateLimitProxy,
  runNode,
  nodeBinary,
  nodeEnv,
};
