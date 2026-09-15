'use strict';
// 插件商店。隔离原则：
// - 一律通过 dsh 自带的 `dsh plugin --profile <name> add/remove`（内部转发 pnpm），
//   插件落到 $DSH_HOME/profiles/<name>/node_modules，绝不碰系统 npm/pnpm 全局目录。
// - DSH_HOME 固定在 %APPDATA%\dsh-desktop\dsh-home，重装应用、切换内核都不丢插件。
// - 包名/版本拼进 pnpm 参数前做白名单校验（防参数注入）。
// - 插件下载走独立的本地 CONNECT 隧道代理（与内核下载双通道隔离）。
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const store = require('./config-store');
const core = require('./core-manager');
const { assertPkg, assertVersion } = core;

const DEFAULT_PROFILE = 'web';
// 商店目录：官方 cordis 插件 + 常用第三方（都可手动输入任意合法包名）
const CATALOG = [
  { name: '@deepseek-ai/cordis-plugin-hmr', desc: 'HMR 服务（dsh Cordis 插件热更新）' },
];

function currentEntry() {
  const version = store.getConfig().kernelVersion || store.DEFAULT_KERNEL_VERSION;
  const status = core.snapshotStatus(version);
  if (!status.installed) {
    const err = new Error('KERNEL_NOT_INSTALLED');
    err.version = version;
    throw err;
  }
  return path.join(status.dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}

function profileDir(profile) {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(profile)) throw new Error(`非法 profile 名: ${profile}`);
  return path.join(store.paths.dshHome(), 'profiles', profile);
}

// dsh plugin 转发 pnpm 时要求 profile 目录存在；缺失则引导一个最小 profile
function ensureProfile(profile) {
  const dir = profileDir(profile);
  const pkgFile = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgFile)) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(pkgFile, JSON.stringify({ name: `dsh-profile-${profile}`, private: true }, null, 2));
    core.writePnpmNpmrc(dir); // 镜像 + 构建脚本放行，与内核安装同源
  }
  return dir;
}

function runDsh(args, { onStdout } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(core.nodeBinary(), ['--expose-internals', currentEntry(), ...args], {
      cwd: store.paths.workspace(),
      env: { ...core.nodeEnv(), DSH_HOME: store.paths.dshHome() },
      windowsHide: true,
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; onStdout && onStdout(d.toString()); });
    child.stderr.on('data', (d) => { err += d; onStdout && onStdout(d.toString()); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err || out || `exit ${code}`))));
  });
}

function listInstalled(profile = DEFAULT_PROFILE) {
  const dir = profileDir(profile);
  const deps = {};
  for (const f of ['package.json']) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      Object.assign(deps, pkg.dependencies || {}, pkg.devDependencies || {});
    } catch { /* profile 不存在 */ }
  }
  return Object.entries(deps).map(([name, version]) => ({ name, version, profile }));
}

// 商店目录（内置）+ 用户自定义目录（存 plugin-manifest.json，随数据目录持久化）
async function catalog(limitKBps = 0) {
  const all = [...CATALOG, ...userCatalog()];
  const items = await Promise.all(all.map(async (item) => {
    try {
      const meta = await core.fetchRegistryMeta(item.name, limitKBps);
      return { ...item, custom: !!item.custom, versions: meta.versions.sort().reverse().slice(0, 10) };
    } catch {
      return { ...item, custom: !!item.custom, versions: [] };
    }
  }));
  return items;
}

function userCatalog() {
  const m = store.readManifest();
  return (m.customCatalog || []).slice();
}

// 用户把任意合法包名收进商店目录，下次不用重新输入
function addToCatalog(name, desc = '') {
  assertPkg(name);
  const base = String(name);
  const m = store.readManifest();
  m.customCatalog = m.customCatalog || [];
  if (!CATALOG.some((c) => c.name === base) && !m.customCatalog.some((c) => c.name === base)) {
    m.customCatalog.push({ name: base, desc: desc || '自定义插件', custom: true });
  }
  store.writeManifest(m);
  return { ok: true, catalog: userCatalog() };
}

function removeFromCatalog(name) {
  assertPkg(name);
  const m = store.readManifest();
  m.customCatalog = (m.customCatalog || []).filter((c) => c.name !== name);
  store.writeManifest(m);
  return { ok: true, catalog: userCatalog() };
}

// spec 字段: "name" 或 "name@version"；版本可省略装 latest
async function add(spec, profile = DEFAULT_PROFILE, { limitKBps = 0, onProgress } = {}) {
  const at = spec.lastIndexOf('@');
  let name, version = null;
  if (spec.startsWith('@')) {
    // @scope/pkg 或 @scope/pkg@1.2.3
    const i = spec.indexOf('@', 1);
    if (i > 0) { name = spec.slice(0, i); version = spec.slice(i + 1); }
    else name = spec;
  } else {
    const i = spec.indexOf('@');
    if (i > 0) { name = spec.slice(0, i); version = spec.slice(i + 1); }
    else name = spec;
  }
  assertPkg(name);
  if (version) assertVersion(version);
  const target = version ? `${name}@${version}` : name;
  ensureProfile(profile);

  const proxy = await core.startRateLimitProxy(limitKBps);
  try {
    onProgress && onProgress(`安装插件 ${target} 到 profile ${profile}...`);
    const out = await runDsh(['plugin', '--profile', profile, 'add', target], { onStdout: (m) => onProgress && onProgress(m.trim()) });
    recordPlugin(name, version || 'latest', profile, 'add');
    return { ok: true, name, version: version || 'latest', out };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    proxy.close();
  }
}

async function remove(name, profile = DEFAULT_PROFILE) {
  assertPkg(name);
  try {
    await runDsh(['plugin', '--profile', profile, 'remove', name]);
    recordPlugin(name, null, profile, 'remove');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function recordPlugin(name, version, profile, action) {
  const m = store.readManifest();
  m.plugins = (m.plugins || []).filter((p) => !(p.name === name && p.profile === profile));
  if (action === 'add') m.plugins.push({ name, version, profile, at: new Date().toISOString() });
  store.writeManifest(m);
}

module.exports = {
  DEFAULT_PROFILE, CATALOG, listInstalled, catalog, add, remove, profileDir, ensureProfile,
  userCatalog, addToCatalog, removeFromCatalog,
};
