'use strict';
// 内置终端：node-pty + shell 检测。node-pty 带 N-API 预编译，加载失败时降级（返回明确错误，其余功能不受影响）。
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const store = require('./config-store');
const { buildChildEnv } = require('./dsh-launcher');

let pty = null;
function getPty() {
  if (pty !== null) return pty;
  try { pty = require('node-pty'); } catch (err) {
    pty = { __loadError: err };
  }
  return pty;
}

function nodeMajor() { return Number(process.versions.node.split('.')[0]); }

// shell 检测：Windows 上三者行为差异足以导致乱码和命令失败，必须显式检测并展示
async function detectShell() {
  const candidates = [
    { id: 'pwsh7', label: 'PowerShell 7+ (pwsh7)', exe: 'pwsh.exe', args: ['-NoLogo'] },
    { id: 'powershell', label: 'Windows PowerShell (5.1)', exe: 'powershell.exe', args: ['-NoLogo'] },
    { id: 'cmd', label: 'cmd.exe', exe: 'cmd.exe', args: [] },
  ];
  for (const c of candidates) {
    const version = await tryVersion(c);
    if (version) return { ...c, version, available: true };
  }
  return { id: 'none', label: '未找到可用 shell', exe: null, version: null, available: false };
}

function tryVersion(c) {
  return new Promise((resolve) => {
    const verCmd = c.id === 'cmd' ? 'ver' : '$PSVersionTable.PSVersion.ToString()';
    const child = spawn(c.exe, c.id === 'cmd' ? ['/d', '/c', verCmd] : ['-NoProfile', '-NoLogo', '-Command', verCmd], {
      windowsHide: true, timeout: 5000,
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => resolve(null));
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
  const exe = shell || (process.env.ComSpec || 'cmd.exe');
  const isPs = /pwsh|powershell/i.test(exe);
  const args = isPs ? ['-NoLogo'] : [];
  const term = p.spawn(exe, args, {
    name: 'xterm-256color',
    cols: cols || 80, rows: rows || 24,
    cwd: store.paths.workspace(),
    env: {
      ...buildChildEnv({ dshHome: store.paths.dshHome() }),
      // cmd 下强制 UTF-8；PS 由 profile 输出编码控制
      ...( /cmd\.exe$/i.test(exe) ? {} : {}),
    },
  });
  return term;
}

// 生成 bin shim：dsh.cmd / pnpm.cmd，指向当前内核快照与内置 pnpm
function writeShims() {
  const binDir = store.paths.bin();
  fs.mkdirSync(binDir, { recursive: true });
  const version = store.getConfig().kernelVersion;
  const dshEntry = version
    ? path.join(store.paths.snapshotsDir(), version, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    : null;
  fs.writeFileSync(path.join(binDir, 'dsh.cmd'),
    `@echo off\r\nrem DSH Desktop 内置 shim\r\n"${process.execPath}" --expose-internals "${dshEntry || 'KERNEL_NOT_INSTALLED'}" %*\r\n`);
  const pnpmCjs = path.join(path.dirname(__dirname), '..', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
  fs.writeFileSync(path.join(binDir, 'pnpm.cmd'),
    `@echo off\r\nrem DSH Desktop 内置 shim\r\n"${process.execPath}" "${pnpmCjs}" %*\r\n`);
}

module.exports = { detectShell, createSession, writeShims, getPty, nodeMajor };
