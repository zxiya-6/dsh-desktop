'use strict';
// smoke:plugins —— 插件商店通道：bootstrap profile → 经 dsh plugin 安装 → 已装列表 → 卸载
// 并断言插件落点在 dsh-home 内（与系统 npm 隔离）
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const store = require('../src/main/config-store');
const pluginStore = require('../src/main/plugin-store');

const assert = (cond, msg) => { if (!cond) throw new Error('断言失败: ' + msg); console.log('[smoke] ok —', msg); };

app.whenReady().then(async () => {
  const profile = 'smoke-test';
  try {
    store.ensureDirs();
    // 1. bootstrap profile 并安装一个极小的真实 npm 包（验证通道，不污染系统）
    const r = await pluginStore.add('ms', profile, { onProgress: (m) => process.stdout.write('[smoke] ' + m.trim() + '\n') });
    assert(r.ok, `经 dsh plugin 安装 ms: ${r.ok ? '' : r.error}`);

    // 2. 落点隔离：必须出现在 dsh-home/profiles/<profile>/node_modules
    const target = path.join(pluginStore.profileDir(profile), 'node_modules', 'ms', 'package.json');
    assert(fs.existsSync(target), `插件落点在 DSH_HOME 内: ${target}`);

    // 3. 已安装列表可见
    const installed = pluginStore.listInstalled(profile);
    assert(installed.some((p) => p.name === 'ms'), `listInstalled 可见: ${installed.map((p) => p.name).join(', ') || '(空)'}`);

    // 4. 清单记录
    const m = store.readManifest();
    assert((m.plugins || []).some((p) => p.name === 'ms' && p.profile === profile), 'plugin-manifest.json 已记录');

    // 5. 卸载并确认移除
    const rm = await pluginStore.remove('ms', profile);
    assert(rm.ok, '卸载成功');
    assert(!fs.existsSync(target), '卸载后 node_modules 内已移除');
    console.log('[smoke] PASS');
    app.exit(0);
  } catch (err) {
    console.error('[smoke] FAIL —', err.message);
    app.exit(1);
  }
});
