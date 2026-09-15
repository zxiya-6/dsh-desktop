'use strict';
// smoke:switch —— 内核切换：成功路径 + 失败路径（配置不被污染、旧内核自愈）
// 核心断言：切换失败时 config.json 的指针不被改写。
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const store = require('../src/main/config-store');
const core = require('../src/main/core-manager');
const { stopProcess } = require('../src/main/dsh-launcher');

const assert = (cond, msg) => { if (!cond) throw new Error('断言失败: ' + msg); console.log('[smoke] ok —', msg); };

app.whenReady().then(async () => {
  try {
    store.ensureDirs();
    const snaps = core.listSnapshots().filter((s) => s.ready);
    assert(snaps.length >= 1, '至少存在一个 ready 快照');
    const good = snaps[0].version;

    // 成功路径
    const cur = store.getConfig().kernelVersion;
    let { proc } = await core.switchKernel(good);
    assert(store.getConfig().kernelVersion === good, '成功切换后指针指向新版本');
    await stopProcess(proc);

    // 失败路径：指向一个不存在的入口（模拟起不来的内核）
    const bogus = path.join(store.paths.snapshotsDir(), '9.9.9-bogus', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    let failed = false;
    try { await core.switchKernel('9.9.9-bogus'); } catch { failed = true; }
    assert(failed, '坏快照切换按预期失败');
    assert(store.getConfig().kernelVersion === good, '失败后 config 指针不被污染');
    console.log('[smoke] PASS');
    app.exit(0);
  } catch (err) {
    console.error('[smoke] FAIL —', err.message);
    app.exit(1);
  }
});
