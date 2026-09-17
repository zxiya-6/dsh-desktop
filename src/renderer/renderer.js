'use strict';
/* global Terminal, FitAddon */
const $ = (s) => document.querySelector(s);
const currentVersion = { value: null };

// HTML 转义：插件名/版本/描述来自 npm 第三方数据，插值进 innerHTML 前必须过这里
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

// ---- 导航 ----
document.querySelectorAll('#nav button').forEach((btn) => {
  btn.addEventListener('click', () => showView(btn.dataset.view));
});
window.dsh.on('ui:navigate', (v) => showView(v));

function showView(v) {
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  document.querySelectorAll('section.view').forEach((s) => s.classList.toggle('active', s.id === 'view-' + v));
  if (v === 'terminal') initTerminal();
  if (v === 'kernel') refreshKernel();
  if (v === 'plugins') refreshPlugins();
}

// ---- 插件商店 ----
function curProfile() { return $('#plugin-profile').value; }

async function refreshPlugins() {
  const installed = await window.dsh.plugins.installed(curProfile());
  const tb = $('#installed-table tbody'); tb.innerHTML = '';
  if (!installed.length) {
    tb.innerHTML = '<tr><td colspan="3" class="muted">该 profile 尚未安装插件</td></tr>';
  }
  for (const p of installed) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${esc(p.name)}</td><td>${esc(p.version)}</td><td><button class="act ghost" data-rm="${esc(p.name)}">卸载</button></td>`;
    tb.appendChild(tr);
  }
  tb.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(`从 profile ${curProfile()} 卸载 ${b.dataset.rm}？`)) return;
    const r = await window.dsh.plugins.remove(b.dataset.rm, curProfile());
    if (!r.ok) alert('卸载失败：' + r.error);
    refreshPlugins();
  }));

  const cat = await window.dsh.plugins.catalog(0);
  const cb = $('#catalog-table tbody'); cb.innerHTML = '';
  for (const item of cat) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${esc(item.name)}${item.custom ? ' <span class="muted">(自定义)</span>' : ''}</td>
      <td class="muted">${item.desc || ''}</td>
      <td><button class="act ghost" data-cat="${esc(item.name)}">安装</button>
        ${item.custom ? `<button class="act ghost" data-catdel="${esc(item.name)}">移除</button>` : ''}</td>`;
    cb.appendChild(tr);
  }
  cb.querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', () => {
    $('#plugin-spec').value = b.dataset.cat;
    $('#btn-plugin-add').click();
  }));
  cb.querySelectorAll('[data-catdel]').forEach((b) => b.addEventListener('click', async () => {
    await window.dsh.plugins.catalogRemove(b.dataset.catdel);
    refreshPlugins();
  }));
}

$('#btn-plugin-add').addEventListener('click', async () => {
  const spec = $('#plugin-spec').value.trim();
  if (!spec) return;
  const log = $('#plugin-log');
  log.textContent += `>>> 安装 ${spec} → profile ${curProfile()}\n`;
  const off = window.dsh.on('plugins:progress', (m) => { log.textContent += m + '\n'; log.scrollTop = log.scrollHeight; });
  const r = await window.dsh.plugins.add(spec, curProfile(), Number($('#rate').value) || 0);
  off();
  if (!r.ok) alert('安装失败：' + r.error);
  refreshPlugins();
});

$('#btn-plugin-save').addEventListener('click', async () => {
  const spec = $('#plugin-spec').value.trim();
  if (!spec) return;
  // 去掉版本部分：@scope/pkg@1.0.0 → @scope/pkg；pkg@1.0.0 → pkg
  let name = spec;
  const scopeIdx = spec.indexOf('@', 1);
  if (scopeIdx > 0) name = spec.slice(0, scopeIdx);
  else if (!spec.startsWith('@') && spec.includes('@')) name = spec.slice(0, spec.indexOf('@'));
  const r = await window.dsh.plugins.catalogAdd(name, '自定义插件');
  if (!r.ok) alert('保存失败：' + r.error);
  else $('#plugin-spec').value = '';
  refreshPlugins();
});

$('#plugin-profile').addEventListener('change', refreshPlugins);

// ---- Web UI：沿用官方界面，桌面层只补宿主能力 ----
window.dsh.on('kernel:status', (st) => {
  const frame = $('#web-frame'), status = $('#web-status');
  if (st.state === 'ready' && st.rolledBack) {
    status.style.display = 'none';
    frame.style.display = 'block';
    frame.src = st.url;
    currentVersion.value = st.version;
    alert(`内核 ${st.from} 无法启动，已自动回滚到 ${st.version}`);
    return;
  }
  if (st.state === 'ready' && st.recovered) {
    status.style.display = 'none';
    frame.style.display = 'block';
    if (frame.src !== st.url) frame.src = st.url;
    currentVersion.value = st.version;
    alert(`内核 ${st.version} 崩溃后已自动恢复`);
    return;
  }
  if (st.state === 'ready') {
    status.style.display = 'none';
    frame.style.display = 'block';
    frame.src = st.url; // 必须用 stdout 解析出的带 token URL，端口随机、cookie 绑 authority
    currentVersion.value = st.version;
  } else if (st.state === 'crashed' || st.state === 'recovering' || st.state === 'rolling_back') {
    frame.style.display = 'none';
    status.style.display = 'block';
    $('#btn-install-first').style.display = 'none';
    $('#web-status-msg').textContent =
      st.state === 'crashed' ? `内核 ${st.version || ''} 意外退出（code=${st.code}），正在自动恢复…` :
      st.state === 'recovering' ? `正在重启内核 ${st.version || ''}（第 ${st.attempt} 次尝试）…` :
      `正在回滚到 ${st.to}（${st.from} 无法启动）…`;
  } else if (st.state === 'down') {
    frame.style.display = 'none';
    status.style.display = 'block';
    $('#btn-install-first').style.display = st.message && st.message.includes('KERNEL_NOT_INSTALLED') ? '' : 'none';
    $('#web-status-msg').textContent = st.message || '内核不可用';
  } else {
    frame.style.display = 'none';
    status.style.display = 'block';
    $('#btn-install-first').style.display = st.message && st.message.includes('KERNEL_NOT_INSTALLED') ? '' : 'none';
    $('#web-status-msg').textContent =
      st.state === 'starting' ? '正在启动内核…' :
      st.state === 'exited' ? '内核进程已退出，可从菜单重新连接。' :
      '启动失败：' + (st.message || '');
  }
});

$('#btn-restart-kernel').addEventListener('click', async () => {
  const msg = $('#web-status-msg');
  msg.textContent = '正在重启内核…';
  const r = await window.dsh.kernel.restart();
  if (!r.ok) msg.textContent = '重启失败：' + r.error;
});

$('#btn-install-first').addEventListener('click', async () => {
  const meta = await window.dsh.kernel.registry(0);
  const v = meta.versions.filter(v => v.includes('rc')).sort().pop() || meta.latest;
  await installAndUse(v);
});

async function installAndUse(v) {
  const r = await window.dsh.kernel.install(v);
  if (!r.ok) { alert('安装失败：' + r.error); return; }
  const sw = await window.dsh.kernel.switchTo(v);
  if (!sw.ok) alert('切换失败：' + sw.error);
  else window.dsh.kernel.start();
}

// ---- 内核管理 ----
async function refreshKernel() {
  const cfg = await window.dsh.config.get();
  $('#keep').value = cfg.keepSnapshots || 3;
  $('#kernel-dir').textContent = cfg.kernelDir || '';
  $('#plugin-dir').textContent = cfg.pluginHome || '';
  $('#runtime-info').textContent = [cfg.browserKernel, cfg.nodeRuntime].filter(Boolean).join('；');
  const meta = await window.dsh.kernel.registry(0);
  const sel = $('#remote-versions');
  sel.innerHTML = '';
  for (const v of meta.versions.sort().reverse().slice(0, 30)) {
    const o = document.createElement('option'); o.value = o.textContent = v; sel.appendChild(o);
  }
  const snaps = await window.dsh.kernel.list();
  const tb = $('#snap-table tbody'); tb.innerHTML = '';
  for (const s of snaps) {
    const tr = document.createElement('tr');
    const isCur = s.version === cfg.kernelVersion;
    tr.innerHTML = `<td>${esc(s.version)}${isCur ? ' <span class="muted">(当前)</span>' : ''}</td>
      <td>${s.ready ? 'ready' : s.installed ? 'installed' : 'broken'}</td>
      <td>
        <button class="act ghost" data-switch="${esc(s.version)}">切换</button>
        ${isCur ? '' : `<button class="act ghost" data-del="${esc(s.version)}">删除</button>`}
      </td>`;
    tb.appendChild(tr);
  }
  tb.querySelectorAll('[data-switch]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    const sw = await window.dsh.kernel.switchTo(b.dataset.switch);
    // 切换成功时主进程已把新内核拉起并广播 ready，这里无需再 start（否则杀掉重起白等 10 秒）
    if (!sw.ok && sw.error !== '内核操作进行中，请稍候') alert('切换失败：' + sw.error);
    refreshKernel();
  }));
  tb.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    const v = b.dataset.del;
    if (!confirm(`删除快照 ${v}？（约 300–400 MB，删除后需重新下载才能再用）`)) return;
    const r = await window.dsh.kernel.delete(v);
    if (!r.ok && r.error !== '内核操作进行中，请稍候') alert('删除失败：' + r.error);
    refreshKernel();
  }));
}

// 内核操作互斥：忙碌期间禁用所有会动内核的按钮，防止连点并发拉起多棵进程树
window.dsh.on('kernel:busy', ({ busy }) => {
  document.querySelectorAll('#snap-table button, #btn-install, #btn-restart-kernel, #btn-plugin-add')
    .forEach((b) => { b.disabled = busy; });
  document.body.style.cursor = busy ? 'progress' : '';
});

// 目录迁移：选目录 → 确认 → 停内核搬迁 → 重启
async function bindRelocate(btnId, kind, label) {
  $(btnId).addEventListener('click', async () => {
    const dir = await window.dsh.settings.pickDir();
    if (!dir) return;
    if (!confirm(`把${label}迁移到\n${dir}\n\n目标必须是空目录；迁移期间内核会重启。`)) return;
    const r = await window.dsh.settings.relocate(kind, dir);
    if (!r.ok) alert('迁移失败：' + r.error);
    else refreshKernel();
  });
}
bindRelocate('#btn-move-kernel', 'core', '内核目录（core，含全部快照）');
bindRelocate('#btn-move-plugins', 'dshHome', '插件主目录（dsh-home，含 profile 与已装插件）');

$('#btn-install').addEventListener('click', async () => {
  const v = $('#remote-versions').value;
  const limit = Number($('#rate').value) || 0;
  const log = $('#install-log');
  const off = window.dsh.on('kernel:progress', (m) => { log.textContent += m + '\n'; log.scrollTop = log.scrollHeight; });
  await installAndUse(v);
  off();
});

$('#keep').addEventListener('change', async (e) => {
  await window.dsh.config.set({ keepSnapshots: Number(e.target.value) || 3 });
});

// ---- 内置终端 ----
let term = null, termId = null, termInit = null;

async function initTerminal() {
  if (termInit) return termInit;
  termInit = (async () => {
    const info = await window.dsh.shell.detect();
    term = new Terminal({ fontFamily: 'Consolas, monospace', fontSize: 13, cursorBlink: true });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open($('#terminal-host'));
    fit.fit();
    term.writeln(`shell: ${info.label}${info.version ? ' version=' + info.version : ''}`);
    term.writeln('内置命令可直接使用: dsh --version | dsh plugin ... | pnpm add <pkg>');
    term.writeln('');
    const r = await window.dsh.terminal.create({ cols: term.cols, rows: term.rows });
    if (!r.ok) { term.writeln('\x1b[31m' + r.error + '\x1b[0m'); return; }
    termId = r.id;
    window.dsh.on('terminal:data:' + termId, (d) => term.write(d));
    window.dsh.on('terminal:exit:' + termId, (code) => term.writeln(`\r\n[进程退出 code=${code}]`));
    term.onData((d) => window.dsh.terminal.input(termId, d));
    window.addEventListener('resize', () => { fit.fit(); window.dsh.terminal.resize(termId, term.cols, term.rows); });
  })();
  return termInit;
}
