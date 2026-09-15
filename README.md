# DSH Desktop

DeepSeek Harness (DSH) 的 Windows 桌面封装：依赖全部内置、与系统环境隔离、自带 Chromium 内核、内置可更新依赖的终端。沿用官方 Web UI，桌面层只负责宿主能力：进程生命周期、端口与鉴权、数据持久化、终端、打包分发。

## 架构速览

### 模块地图（src/main/）

| 模块 | 职责 |
| --- | --- |
| `index.js` | 窗口/菜单/IPC 注册、内核启停编排、鉴权 cookie 预写（iframe SameSite 修复） |
| `config-store.js` | 数据目录布局、config.json 读写、update.lock（O_EXCL + 10 分钟判死）、目录迁移（relocate） |
| `core-manager.js` | 内核快照全生命周期：查询→暂存安装→校验入口→预启动冒烟→提升（promote：rename 重试 + 复制兜底）→切换/回滚/删除/清理 |
| `dsh-launcher.js` | ELECTRON_RUN_AS_NODE 启动 dsh（`--expose-internals web --no-open --port 0`）、waitUntilServing 就绪探测、taskkill /T 进程树终结 |
| `plugin-store.js` | 插件商店：内置目录 + 用户自定义目录（plugin-manifest.json 的 customCatalog）、经 `dsh plugin` 通道装/卸、独立限速代理 |
| `terminal.js` | node-pty 会话、shell 检测（pwsh7→powershell→cmd）、bin shim 生成 |

### 设计要点

- **依赖内置与隔离**：Node 用 Electron 自带的（ELECTRON_RUN_AS_NODE=1，要求 Electron ≥ 44 / Node ≥ 24，因为 dsh 的 import.meta.main 是 Node 24 才有的属性）；pnpm 打包进 node_modules；dsh 本体不进安装包，按需下载。浏览器内核即 Electron 自带 Chromium，随包分发，dsh 以 --no-open 启动，绝不依赖系统浏览器。
- **数据外置、位置可选**：profile / 工作区 / 日志 / 快照默认在 `%APPDATA%\dsh-desktop`（绿色版在 exe 同级 `dsh-desktop-data`），重装升级不丢。内核目录与插件主目录可在设置页一键迁移到任意空目录（跨盘自动退化为复制），config.json 的 kernelRoot / dshHomeRoot 记录覆盖位置。
- **内核动态更新**：快照 → 暂存安装 → 校验入口 → 预启动冒烟（独立 smoke-home + 随机端口）→ 提升 → 切换。只有新内核通过 HTTP 就绪探测才写 config；失败删暂存、指针不动、可一键回滚（历史记在 plugin-manifest.json）。版本切换用 config 指针而非 symlink；快照可单独删除（当前内核受保护）。
- **端口策略**：dsh 默认固定监听 3080，安装冒烟会与运行中的内核 EADDRINUSE——启动参数一律 --port 0 由 OS 挑空闲端口；token URL 仍从 stdout 解析。
- **内置终端**：Ctrl + 反引号。node-pty（N-API 预编译，加载失败自动降级）。shell 显式检测 pwsh 7 → powershell 5.1 → cmd。PATH 以内置 bin shim 优先，直接可用 `dsh --version`、`pnpm add <pkg>`。
- **插件商店**：一律经 dsh 自带 `dsh plugin --profile <name> add/remove`（内部转发内置 pnpm）安装，落点固定 `dsh-home\profiles\<profile>\node_modules`——不碰系统 npm/pnpm 全局目录，重装应用、切换/回滚内核都不丢；可把任意合法包名「存入商店」（持久化 customCatalog）；插件与内核下载各走一条本地 CONNECT 隧道代理。
- **安全**：contextIsolation + sandbox + 无 nodeIntegration；--expose-internals 只授予 dsh 子进程；导航白名单仅回环地址，外链仅 http(s)；app:openPath 限数据目录；版本号/包名拼参数前白名单校验；单实例锁；dsh 的 SameSite=Strict 鉴权 cookie 由主进程预取并以 no_restriction 写入会话（否则 iframe 白屏）。

## 开发

```powershell
npm install
npm start
```

首次启动若 core/snapshots 为空，会提示下载内核（约 522 个依赖，1–2 分钟）。

## 冒烟测试

| 命令 | 验证什么 |
| --- | --- |
| `npm run smoke:terminal` | 内置终端与 shell 检测（node-pty 可用、shell 回显） |
| `npm run seed:core -- 0.1.5-rc.1` | 用内置 pnpm 装一份内核快照 |
| `npm run smoke:kernel` | 从 userData 解析内核并真实启动，拿到带 token 的 URL |
| `npm run smoke:switch` | 切换成功路径 + 失败路径（配置不被污染、可自愈） |
| `npm run smoke:phase2` | 远端元数据、双通道限速、插件清单、回滚候选、并发锁 |
| `npm run smoke:plugins` | 插件商店：经 dsh plugin 安装/卸载，落点在 DSH_HOME 内（与系统隔离） |

除 smoke:terminal 外的脚本需要 Electron 环境：`npx electron scripts/smoke-kernel.js` 等。

## 打包（必须在本机 Windows 上构建，node-pty 原生模块不能交叉编译）

```powershell
npm run dist:win
# 国内网络加速：
$env:ELECTRON_MIRROR = "https://registry.npmmirror.com/-/binary/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://registry.npmmirror.com/-/binary/electron-builder-binaries/"
```

产物在 `dist\`：NSIS 安装包 + 免安装绿色版。

安装器行为（build/installer.nsh）：

- `perMachine` + 可选安装目录；`/S /D=<路径>` 静默安装（`/D=` 必须最后、不加引号）。
- 升级/重装沿用上次目录：安装路径额外备份在 `HKLM\Software\DSH Desktop\InstallPath`，并向 ARP 项补写 InstallLocation。
- 卸载先 `taskkill` 结束应用与 dsh 子进程（同一 exe 映像名，不结束会文件占用），再询问是否删除用户数据；静默卸载等价「否」。

## 关键踩坑（改动前先读）

1. `--expose-internals` 是 dsh Cordis HMR 插件的硬性要求，只加在 dsh 子进程，不给渲染进程。
2. `ELECTRON_RUN_AS_NODE` 下只接受 Node flag，传 `--no-sandbox` 会报 `bad option`。
3. dsh 打印 URL 早于 HTTP listener 就绪，必须 `waitUntilServing()` 轮询（401/303 也算就绪）。
4. Web UI token 绑定 `127.0.0.1:<port>`，必须从 stdout 解析带 token 的 URL，端口每次随机。
5. Node 必须 ≥ 24；下限硬编码在 `config-store.js` 的 `KERNEL_MIN_NODE_MAJOR`（dsh 自己不声明 engines）。
6. pnpm 10 默认不跑依赖构建脚本，`.npmrc` 必须有 `dangerously-allow-all-builds=true`，并把 node-pty/sharp 二进制镜像指到国内。
7. `node-linker=hoisted` 缩短路径，对抗 522 个依赖在 MAX_PATH 260 下的深度嵌套。
8. 切换顺序必须是 stop → 启动新快照 → 成功后写 config；`smoke:switch` 验证这条。
9. 冒烟用独立 smoke-home，不污染真实 DSH_HOME；冒烟通过不代表带真实 profile 一定能起，所以切换仍要回滚。

## 已知限制

仅 Windows x64；dsh 是 0.1.x-rc 开发者预览，锁版本（默认 0.1.5-rc.1）；单个内核快照 300–400 MB，默认保留 3 份；首次启动需联网下载内核；安装路径尽量浅（建议 `D:\dsh` 这类短路径）。

License: MIT

## 本轮新增（2026-09-15 下午/晚间）

- **快照删除**：内核管理页每个非当前快照带「删除」按钮（当前内核受保护，先切换再删；删除有确认提示）。`core-manager.deleteSnapshot`。
- **内核/插件安装位置可选**：内核管理页「安装位置」卡片。更换目录时先停内核 → 整目录搬到新空目录（跨盘自动退化为复制）→ 写 config 指针 → 重启。`config-store.relocate`；config.json 的 `kernelRoot` / `dshHomeRoot` 指定覆盖位置。
- **浏览器内核随包**：Electron 44 内置 Chromium 142 + Node 24，dsh 以 `--no-open --port 0` 启动，绝不拉系统浏览器、绝不占固定端口。「运行环境」卡片展示版本。
- **自定义插件**：插件商店支持手动输入任意合法包名（自动剥离版本）并「存入商店」，持久化在 plugin-manifest.json 的 `customCatalog`；自定义项带移除按钮。安装仍走 `dsh plugin --profile <name> add`，落点 `dsh-home\profiles\<profile>\node_modules`，与系统 npm 隔离。
- 新增冒烟：`npm run smoke:plugins`。

### 又踩的两个坑（实机验证）

10. **dsh 默认固定监听 3080 端口**：安装/切换的预启动冒烟会与正在运行的内核 EADDRINUSE。启动参数必须带 `--port 0` 让 OS 挑空闲端口。
11. **iframe 内 SameSite=Strict 鉴权 cookie 被拦**：宿主页(file://)与 iframe(http://127.0.0.1) 是跨站上下文，dsh web 的 303 Set-Cookie 进不去 → 白屏 "authentication required"。主进程先用 node:http 取回 Set-Cookie（net.request 的 redirect:'manual' 会直接报 "Redirect was cancelled"，不能用），再以 `sameSite: 'no_restriction'` 写进 session.defaultSession.cookies。
12. **xterm 资源**：渲染页需显式引用 `node_modules/@xterm/xterm/{css/xterm.css,lib/xterm.js}` 与 addon-fit，且在 renderer.js 之前加载。

### 健壮性设计（2026-09-16）

- **快照保留下限 2**：keepSnapshots 在 config/IPC/UI 三处钳制为 ≥ 2（`MIN_KEEP_SNAPSHOTS`），当前内核之外永远有一份可回滚。删除快照时同样校验：删完不足两份 ready 直接拒绝。
- **内核监督器**（index.js `attachSupervisor`/`supervisorRecover`）：内核意外退出（非 0 退出码）→ 原地自动重启最多 2 次（指数退避）；仍起不来 → 自动回滚到最近一份 ready 的其他快照并写回指针（记入回滚历史）；全部失败才报 `down` 交给用户处理。正常退出（code=0）与主动切换/重连不会误触发。
- 实弹验证：`taskkill /F` 内核 → 1.5s 内原地恢复；破坏 rc.1 入口文件后强杀 → 4s 内自动回滚到 0.1.6-alpha.1，指针与回滚历史正确落盘。
