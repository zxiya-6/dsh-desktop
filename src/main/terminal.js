'use strict';
// 内置终端：node-pty + shell 检测。node-pty 带 N-API 预编译（win/linux），加载失败时降级（返回明确错误，其余功能不受影响）。
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const store = require('./config-store');
const { buildChildEnv } = require('./dsh-launcher');

const IS_WIN = process.platform === 'win32';

let pty = null;
function getPty() {
  if (pty !== null) return pty;
  try { pty = require('node-pty'); } catch (err) {
    pty = { __loadError: err };
  }
  return pty;
}

function nodeMajor() { return Number(process.versions.node.split('.')[0]); }

// shell 检测：平台各按优先级探测。Windows 上 pwsh/PS/cmd 行为差异大必须显式检测；
// Linux/macOS 用 login shell 顺序 bash → zsh → sh。
async function detectShell() {
  const candidates = IS_WIN ? [
    { id: 'pwsh7', label: 'PowerShell 7+ (pwsh7)', exe: 'pwsh.exe', args: ['-NoLogo'] },
    { id: 'powershell', label: 'Windows PowerShell (5.1)', exe: 'powershell.exe', args: ['-NoLogo'] },
    { id: 'cmd', label: 'cmd.exe', exe: 'cmd.exe', args: [] },
  ] : [
    { id: 'bash', label: 'bash', exe: 'bash', args: [] },
    { id: 'zsh', label: 'zsh', exe: 'zsh', args: [] },
    { id: 'sh', label: 'sh', exe: 'sh', args: [] },
  ];
  for (const c of candidates) {
    const version = await tryVersion(c);
    if (version) return { ...c, version, available: true };
  }
  return { id: 'none', label: '未找到可用 shell', exe: null, version: null, available: false };
}

function tryVersion(c) {
  return new Promise((resolve) => {
    let args;
    if (c.id === 'cmd') args = ['/d', '/c', 'ver'];
    else if (c.id === 'pwsh7' || c.id === 'powershell') args = ['-NoProfile', '-NoLogo', '-Command', '$PSVersionTable.PSVersion.ToString()'];
    // bash/zsh/sh：--version 是纯参数打印，不进交互循环，绝对安全
    else args = ['--version'];
    const child = spawn(c.exe, args, {
      windowsHide: true,
      timeout: 5000,
      env: { ...process.env }, // 显式继承完整 PATH，防 pty 子环境缺路径
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', () => {});
    child.on('error', (e) => { console.error(`[shell-detect] ${c.exe}: ${e.message}`); resolve(null); });
    child.on('close', (code) => {
      if (code !== 0) return resolve(null);
      const v = out.trim().split(/\r?\n/).filter(Boolean).pop() || null;
      resolve(v);
    });
  });
}

// 启动一个 pty 会话，注入内置环境（bin shim 目录优先于系统 PATH）
function createSession(cols, rows) {
  const p = getPty();
  if (p.__loadError) {
    const err = new Error(`终端不可用：node-pty 加载失败（${p.__loadError.message}）。其余功能照常可用。`);
    err.code = 'PTY_UNAVAILABLE';
    throw err;
  }
  const shell = store.getConfig().shell || null;
  const exe = shell || (IS_WIN ? (process.env.ComSpec || 'cmd.exe') : (process.env.SHELL || 'bash'));
  const isPs = /pwsh|powershell/i.test(exe);
  const args = isPs ? ['-NoLogo'] : [];
  const term = p.spawn(exe, args, {
    name: 'xterm-256color',
    cols: cols || 80, rows: rows || 24,
    cwd: store.paths.workspace(),
    env: {
      ...buildChildEnv({ dshHome: store.paths.dshHome() }),
      // Linux 下保证 UTF-8 locale，防乱码
      ...(IS_WIN ? {} : { LANG: process.env.LANG || 'C.UTF-8' }),
    },
  });
  return term;
}

// 生成 bin shim，指向当前内核快照与内置 pnpm
// Windows: dsh.cmd/pnpm.cmd；Linux/macOS: dsh/pnpm 可执行脚本
function writeShims() {
  const binDir = store.paths.bin();
  fs.mkdirSync(binDir, { recursive: true });
  const version = store.getConfig().kernelVersion;
  const dshEntry = version
    ? path.join(store.paths.snapshotsDir(), version, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    : null;
  const pnpmCjs = path.join(path.dirname(__dirname), '..', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
  if (IS_WIN) {
    fs.writeFileSync(path.join(binDir, 'dsh.cmd'),
      `@echo off\r\nrem DSH Desktop 内置 shim\r\n"${process.execPath}" --expose-internals "${dshEntry || 'KERNEL_NOT_INSTALLED'}" %*\r\n`);
    fs.writeFileSync(path.join(binDir, 'pnpm.cmd'),
      `@echo off\r\nrem DSH Desktop 内置 shim\r\n"${process.execPath}" "${pnpmCjs}" %*\r\n`);
  } else {
    for (const [name, target] of [['dsh', dshEntry], ['pnpm', pnpmCjs]]) {
      const f = path.join(binDir, name);
      fs.writeFileSync(f,
        `#!/bin/sh\n# DSH Desktop 内置 shim\nexec "${process.execPath}" --expose-internals "${target || 'KERNEL_NOT_INSTALLED'}" "$@"\n`);
      fs.chmodSync(f, 0o755);
    }
  }
}

module.exports = { detectShell, createSession, writeShims, getPty, nodeMajor };
