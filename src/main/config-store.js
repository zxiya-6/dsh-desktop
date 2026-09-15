'use strict';
// 目录布局与 config.json 的唯一来源。
// 数据全部放在安装目录之外（%APPDATA%\dsh-desktop），重装/升级不带走 profile、会话与插件。
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

// dsh 没有声明 engines，Node >= 24 是硬编码下限：
// Node 22 上 bin.js 的 import.meta.main 为 undefined，dsh 静默退出、退出码 0、无报错。
const KERNEL_MIN_NODE_MAJOR = 24;
const DEFAULT_KERNEL_VERSION = '0.1.5-rc.1';
// 日常至少保留两个内核快照：当前版本之外永远有一份可回滚的
const MIN_KEEP_SNAPSHOTS = 2;
const DEFAULT_KEEP_SNAPSHOTS = 3;

let root = null;

function appDataDir() {
  // Electron 内用 app.getPath；冒烟脚本等纯 Node 环境直接用 %APPDATA%
  if (app && typeof app.getPath === 'function') return app.getPath('appData');
  return process.env.APPDATA || path.join(require('node:os').homedir(), 'AppData', 'Roaming');
}

function initRoot() {
  if (root) return root;
  const exeDir = path.dirname(process.execPath);
  // 数据目录优先级：环境变量 > 安装目录 data-dir 标记文件 > 绿色版同级 > 默认 %APPDATA%。
  // data-dir 标记实现按安装隔离：文件内容为一行（绝对路径，或相对安装目录的子目录名），
  // 多份 dsh-desktop 安装各写各的，即互不共享内核/插件/凭据。
  let overridden = null;
  if (process.env.DSH_DESKTOP_DATA_DIR) {
    overridden = path.resolve(process.env.DSH_DESKTOP_DATA_DIR);
  } else {
    try {
      const marker = path.join(exeDir, 'data-dir');
      if (fs.existsSync(marker)) {
        const line = fs.readFileSync(marker, 'utf8').trim().split(/\r?\n/)[0];
        if (line) {
          overridden = path.isAbsolute(line) ? path.resolve(line) : path.resolve(exeDir, line);
        }
      }
    } catch { /* 标记读取失败按默认走 */ }
  }
  if (overridden) {
    root = overridden;
  } else {
    // 绿色版（portable target）：数据写 exe 同级 dsh-desktop-data\
    const isPortable = exeDir.toLowerCase().includes('portable') ||
      (process.env.DSH_DESKTOP_PORTABLE === '1');
    root = isPortable
      ? path.join(exeDir, 'dsh-desktop-data')
      : path.join(appDataDir(), 'dsh-desktop');
  }
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function p(...seg) { return path.join(initRoot(), ...seg); }

const paths = {
  root: () => initRoot(),
  // 内核与插件目录支持用户自选位置（对抗 C 盘空间/MAX_PATH），未配置时用默认值。
  // config.json 本体始终在 root，所以覆盖项自身不会递归。
  dshHome: () => readConfig().dshHomeRoot || p('dsh-home'),
  workspace: () => p('workspace'),
  logs: () => p('logs'),
  bin: () => p('bin'),
  configFile: () => p('config.json'),
  pluginManifest: () => p('plugin-manifest.json'),
  coreDir: () => readConfig().kernelRoot || p('core'),
  snapshotsDir: () => path.join(paths.coreDir(), 'snapshots'),
  stagingDir: () => path.join(paths.coreDir(), 'staging'),
  updateLock: () => path.join(paths.coreDir(), 'update.lock'),
};

// 更换内核/插件目录：目标必须为空目录，现有数据整体搬过去（跨盘用复制）。
// 调用方需先停掉内核与相关子进程。
function relocate(kind, newPath) {
  const key = kind === 'core' ? 'kernelRoot' : 'dshHomeRoot';
  newPath = path.resolve(String(newPath));
  if (!/^[A-Za-z]:\\/.test(newPath) && !newPath.startsWith('\\\\')) throw new Error('需要一个本地绝对路径');
  const cur = kind === 'core' ? paths.coreDir() : paths.dshHome();
  if (path.resolve(cur).toLowerCase() === newPath.toLowerCase()) {
    return { ok: true, moved: false, path: cur };
  }
  // 不允许把目录搬进自己里面
  if (newPath.toLowerCase().startsWith(path.resolve(cur).toLowerCase() + path.sep)) {
    throw new Error('新位置不能在当前目录内部');
  }
  fs.mkdirSync(newPath, { recursive: true });
  if (fs.readdirSync(newPath).length > 0) throw new Error('目标目录不为空，请选一个空目录');
  if (fs.existsSync(cur)) {
    try {
      fs.renameSync(cur, newPath);
    } catch {
      // 跨盘 rename 会失败，退回复制
      fs.cpSync(cur, newPath, { recursive: true });
      fs.rmSync(cur, { recursive: true, force: true });
    }
  }
  setConfig({ [key]: newPath });
  ensureDirs();
  return { ok: true, moved: true, path: newPath };
}

function ensureDirs() {
  for (const dir of [paths.dshHome(), paths.workspace(), paths.logs(), paths.bin(), paths.snapshotsDir()]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(paths.configFile(), 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(cfg) {
  const tmp = paths.configFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmp, paths.configFile());
}

function getConfig() {
  const cfg = readConfig();
  return {
    kernelVersion: cfg.kernelVersion || null, // 指针：当前使用哪个快照，不用 symlink
    rateLimitKBps: cfg.rateLimitKBps ?? 0, // 0 = 不限速
    ...cfg,
    // 快照保留数下限 2：当前版本之外永远有一份可回滚（写在展开之后，用户配置也拦住）
    keepSnapshots: Math.max(MIN_KEEP_SNAPSHOTS, cfg.keepSnapshots ?? DEFAULT_KEEP_SNAPSHOTS),
  };
}

function setConfig(patch) {
  const cfg = { ...getConfig(), ...patch };
  writeConfig(cfg);
  return cfg;
}

// 插件与快照清单、回滚历史
function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(paths.pluginManifest(), 'utf8'));
  } catch {
    return { plugins: [], snapshots: [], history: [] };
  }
}

function writeManifest(m) {
  const tmp = paths.pluginManifest() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2), 'utf8');
  fs.renameSync(tmp, paths.pluginManifest());
}

// update.lock：O_EXCL 创建；10 分钟自动判死清理
const LOCK_STALE_MS = 10 * 60 * 1000;

function acquireLock(owner) {
  ensureDirs();
  try {
    const fd = fs.openSync(paths.updateLock(), 'wx'); // O_EXCL
    fs.writeSync(fd, JSON.stringify({ owner, since: Date.now() }));
    fs.closeSync(fd);
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    try {
      const st = fs.statSync(paths.updateLock());
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        fs.unlinkSync(paths.updateLock());
        return acquireLock(owner);
      }
    } catch { /* lock vanished */ }
    return false;
  }
}

function releaseLock() {
  try { fs.unlinkSync(paths.updateLock()); } catch { /* already gone */ }
}

module.exports = {
  KERNEL_MIN_NODE_MAJOR,
  DEFAULT_KERNEL_VERSION,
  DEFAULT_KEEP_SNAPSHOTS,
  MIN_KEEP_SNAPSHOTS,
  paths,
  relocate,
  ensureDirs,
  getConfig,
  setConfig,
  readManifest,
  writeManifest,
  acquireLock,
  releaseLock,
};
