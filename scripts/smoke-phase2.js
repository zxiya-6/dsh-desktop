'use strict';
// smoke:phase2 —— 远端元数据、双通道限速、插件清单、回滚候选、并发锁
const { app, net } = require('electron');
const fs = require('node:fs');
const store = require('../src/main/config-store');
const core = require('../src/main/core-manager');

const assert = (cond, msg) => { if (!cond) throw new Error('断言失败: ' + msg); console.log('[smoke] ok —', msg); };

async function main() {
  store.ensureDirs();

  // 1. 远端元数据
  const meta = await core.fetchRegistryMeta('@deepseek-ai/dsh');
  assert(meta.latest && meta.versions.length > 0, `远端元数据: latest=${meta.latest}, ${meta.versions.length} 个版本`);

  // 2. 双通道限速：两个本地 CONNECT 隧道代理互不影响
  const p1 = await core.startRateLimitProxy(256);
  const p2 = await core.startRateLimitProxy(64);
  assert(p1.url && p2.url && p1.url !== p2.url, `双通道代理: ${p1.url} / ${p2.url}`);
  const probe = await new Promise((resolve, reject) => {
    const req = net.request({ url: 'https://registry.npmjs.org/@deepseek-ai%2Fdsh', proxy: p1.url });
    req.on('response', () => resolve(true));
    req.on('error', reject);
    req.end();
  });
  assert(probe, '限速代理 CONNECT 隧道可用');
  p1.close(); p2.close();

  // 3. 并发锁：O_EXCL + 二次获取失败
  assert(store.acquireLock('smoke'), '获取 update.lock 成功');
  assert(!store.acquireLock('smoke-2'), '第二个获取者被拒绝');
  store.releaseLock();
  assert(store.acquireLock('smoke-3'), '释放后可重新获取');
  store.releaseLock();

  // 4. 插件清单与回滚候选
  store.writeManifest({ ...store.readManifest(), plugins: [] });
  assert(Array.isArray(store.readManifest().plugins), 'plugin-manifest.json 可读写');
  const cands = core.rollbackCandidates();
  assert(Array.isArray(cands), `回滚候选: [${cands.join(', ')}]`);
  console.log('[smoke] PASS');
}

app.whenReady().then(async () => {
  try { await main(); app.exit(0); }
  catch (err) { console.error('[smoke] FAIL —', err.message); app.exit(1); }
});
