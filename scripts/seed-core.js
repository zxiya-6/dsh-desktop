'use strict';
// seed:core —— 用内置 pnpm 装一份内核快照（验证依赖树可跑）
// 用法: npm run seed:core -- 0.1.5-rc.1
// 需要 Electron 环境的部分走 ELECTRON_RUN_AS_NODE；纯安装可直接 node 运行。
const { app } = require('electron');
const store = require('../src/main/config-store');
const core = require('../src/main/core-manager');

app.whenReady().then(async () => {
  const version = process.env.DSH_KERNEL_VERSION || process.argv[2] || store.DEFAULT_KERNEL_VERSION;
  try {
    console.log(`[seed] 安装内核 ${version} 到 ${store.paths.snapshotsDir()}`);
    const s = await core.installSnapshot(version, { onProgress: (m) => console.log('[seed]', m) });
    console.log(`[seed] 完成: ${s.dir}`);
    app.exit(0);
  } catch (err) {
    console.error('[seed] FAIL —', err.message);
    app.exit(1);
  }
});
