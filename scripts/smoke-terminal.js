'use strict';
// smoke:terminal —— 只验证内置终端可用（不启动完整界面）
// 输出示例:
// [smoke] node-pty available: true
// [smoke] shell: PowerShell 7+ (pwsh7) version=7.4.6
// [smoke] PASS — shell responded
const store = require('../src/main/config-store');
const terminal = require('../src/main/terminal');

async function main() {
  store.ensureDirs();
  const pty = terminal.getPty();
  console.log(`[smoke] node-pty available: ${!pty.__loadError}`);
  if (pty.__loadError) {
    console.error('[smoke] FAIL — node-pty 加载失败:', pty.__loadError.message);
    process.exit(1);
  }
  const shell = await terminal.detectShell();
  console.log(`[smoke] shell: ${shell.label}${shell.version ? ' version=' + shell.version : ''}`);
  if (!shell.available) {
    console.error('[smoke] FAIL — 未找到可用 shell');
    process.exit(1);
  }
  // 真实起一个 pty，确认 shell 能回显数据
  const term = terminal.createSession(80, 24);
  const got = await new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => resolve(null), 8000);
    term.onData((d) => {
      data += d;
      if (data.trim().length > 0) { clearTimeout(timer); resolve(data); }
    });
    term.write('echo dsh-smoke-ok\r\n');
  });
  try { term.kill(); } catch {}
  if (!got) {
    console.error('[smoke] FAIL — shell 无回显');
    process.exit(1);
  }
  console.log('[smoke] PASS — shell responded');
  // node-pty 在进程自然退出时会跑 conpty console-list agent 并抛 AttachConsole failed，
  // 属于收尾噪音，直接退出避免误报
  process.exit(0);
}

main().catch((e) => { console.error('[smoke] FAIL —', e.message); process.exit(1); });
