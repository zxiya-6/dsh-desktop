'use strict';
// smoke:kernel —— 从 userData 解析内核并真实启动，拿到带 token 的 URL
// 用法: electron scripts/smoke-kernel.js（需要 Electron 环境跑 ELECTRON_RUN_AS_NODE 与 net 模块）
const { app } = require('electron');
const store = require('../src/main/config-store');
const core = require('../src/main/core-manager');
const { stopProcess } = require('../src/main/dsh-launcher');

app.whenReady().then(async () => {
  try {
    store.ensureDirs();
    const { proc, url, version } = await core.startCurrent();
    console.log('[smoke] kernel version:', version);
    console.log('[smoke] ready url:', url.replace(/token=[^&]*/, 'token=***'));
    await stopProcess(proc);
    console.log('[smoke] PASS');
    app.exit(0);
  } catch (err) {
    console.error('[smoke] FAIL —', err.message);
    app.exit(1);
  }
});
