'use strict';
// dsh 子进程启动器。
// 关键点（实机踩坑，改动前先读）：
// 1. ELECTRON_RUN_AS_NODE=1 让 Electron 二进制当纯 Node 用，省掉 50MB Node 运行时。
//    该模式下只接受 Node flag，传 --no-sandbox 会报 bad option。
// 2. --expose-internals 是 dsh Cordis HMR 插件的硬性要求，只授予 dsh 子进程，
//    绝不授予任何渲染进程。
// 3. dsh 打印 URL 早于 HTTP listener 就绪，必须 waitUntilServing() 轮询，
//    拿到 HTTP 响应（401/303 也算就绪）才能让窗口加载。
// 4. token 绑定 authority，必须从 stdout 解析带 token 的 URL，端口每次随机。
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const store = require('./config-store');

function buildChildEnv({ dshHome, extraPathDirs = [] }) {
  const binDir = store.paths.bin();
  // 子进程 PATH 以内置目录优先：系统的 Node/npm/pnpm 不会干扰
  const pathHead = [binDir, ...extraPathDirs].filter(Boolean).join(path.delimiter);
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    DSH_HOME: dshHome,
    PATH: `${pathHead}${path.delimiter}${process.env.PATH || ''}`,
  };
  // 环境滤毒：NODE_OPTIONS 能让 run-as-node 子进程加载任意 JS（--require）
  delete env.NODE_OPTIONS;
  return env;
}

// 启动内核。opts.entry: dsh bin.js 绝对路径；opts.dshHome: DSH_HOME
function launchKernel({ entry, dshHome, cwd, env = {}, onStdout, onStderr, onExit }) {
  if (!fs.existsSync(entry)) {
    const err = new Error('KERNEL_NOT_INSTALLED');
    err.version = store.getConfig().kernelVersion;
    throw err;
  }
  // Node >= 24 是硬下限：import.meta.main 在 Node 22 上是 undefined，
  // dsh 会静默退出、退出码 0、无任何报错。
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < store.KERNEL_MIN_NODE_MAJOR) {
    throw new Error(`Electron 内置 Node ${process.versions.node} 低于 dsh 要求的 >= ${store.KERNEL_MIN_NODE_MAJOR}`);
  }
  // `web` 子命令 = boot web profile（dsh 要求 --profile/子命令，否则 error: --profile is required）
  // --no-open：不拉起系统浏览器；--port 0：OS 挑空闲端口——dsh 默认固定 3080，
  // 安装冒烟会与正在运行的内核 EADDRINUSE（实机踩过）
  const args = ['--expose-internals', entry, 'web', '--no-open', '--port', '0'];
  const proc = spawn(process.execPath, args, {
    cwd,
    env: { ...buildChildEnv({ dshHome }), ...env },
    windowsHide: true,
    // posix 下 detached 让内核自成进程组：停进程时 kill(-pid) 连子进程树一起终结
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logStream = fs.createWriteStream(path.join(store.paths.logs(), 'dsh.log'), { flags: 'a' });
  const stamp = () => new Date().toISOString();
  logStream.write(`\n[${stamp()}] launch pid=${proc.pid} entry=${entry}\n`);

  let stdoutBuf = '';
  proc.stdout.on('data', (d) => {
    stdoutBuf += d.toString();
    logStream.write(d);
    onStdout && onStdout(d);
  });
  proc.stderr.on('data', (d) => {
    logStream.write(d);
    onStderr && onStderr(d);
  });
  proc.on('exit', (code, signal) => {
    logStream.write(`[${stamp()}] exit code=${code} signal=${signal}\n`);
    logStream.end();
    onExit && onExit(code, signal);
  });
  proc._parsedUrl = null;
  proc._getParsedUrl = () => {
    if (!proc._parsedUrl) {
      // dsh web: http://127.0.0.1:<port>/?token=...
      const m = stdoutBuf.match(/https?:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9._-]+/);
      if (m) proc._parsedUrl = m[0];
    }
    return proc._parsedUrl;
  };
  proc._logStream = logStream;
  return proc;
}

// 等到端口真正可服务：轮询 HTTP，任何响应（含 401/303）即就绪。
function waitUntilServing(proc, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (proc.exitCode !== null) {
        return reject(new Error(`dsh 提前退出 code=${proc.exitCode}。常见原因：Node 版本过低导致静默退出，或缺少 --expose-internals。详见日志 ${store.paths.logs()}\\dsh.log`));
      }
      const url = proc._getParsedUrl();
      if (url) {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
          // 401/303 都算就绪：有 HTTP 响应即 listener 已在服务
          if (res.status) {
            proc._servingUrl = url;
            return resolve(url);
          }
        } catch { /* not yet */ }
      }
      if (Date.now() > deadline) return reject(new Error(`等待 dsh 就绪超时（${timeoutMs}ms）。日志: ${store.paths.logs()}\\dsh.log`));
      setTimeout(tick, 400);
    };
    tick();
  });
}

function stopProcess(proc) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null) return resolve();
    const killTimer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000);
    proc.once('exit', () => { clearTimeout(killTimer); resolve(); });
    if (process.platform === 'win32') {
      // proc.kill() 只杀父进程；dsh 会拉起 worker/子进程，句柄不释放会锁住快照目录
      // （rename 提升时报 EPERM）。taskkill /T 连整棵进程树一起终结。
      try {
        spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true });
      } catch { try { proc.kill(); } catch {} }
    } else {
      // 内核以 detached 启动自成进程组：kill(-pid) 连 worker/子进程整组终结
      try { process.kill(-proc.pid, 'SIGTERM'); }
      catch { try { proc.kill('SIGTERM'); } catch {} }
    }
  });
}

module.exports = { launchKernel, waitUntilServing, stopProcess, buildChildEnv };
