# 手机远程控制（Remote control）

从手机浏览器控制正在运行的 OMP Desktop：看消息、发指令、批准工具调用——手机看到的就是桌面上那同一批 tab，agent 始终跑在你的电脑上。

## 组成

```
手机浏览器 ──HTTPS──▶ 你的服务器 (relay) ◀──WSS 出站── OMP Desktop
```

- **relay**：`relay/` 目录的单文件 Rust 二进制，放在你自己的服务器上。只做三件事：托管手机端页面、转发 WebSocket 帧、管配对。它不解析内容。
- **桌面连接器**：App 内置（Settings → Remote）。只发出站连接，你的电脑不开任何入站端口。

## 部署 relay（一次性，约 5 分钟）

```bash
cd relay && cargo build --release
scp target/release/omp-relay your-server:/usr/local/bin/
```

服务器上建 `/etc/omp-relay/config.json`：

```json
{
  "bind": "127.0.0.1:8787",
  "static_dir": "/etc/omp-relay/public",
  "devices": { "<桌面设备ID>": "<设备令牌的 sha256>" },
  "state_file": "/etc/omp-relay/relay-state.json"
}
```

每台要远程控制的电脑在 `devices` 里占一条（各自的设备 ID + 令牌哈希），共用同一个 relay 互不干扰。

在仓库里 `npm run build:frontend` 生成 `dist/`，把 `dist/` 拷到 `/etc/omp-relay/public/`（必须是预编译产物——relay 的严格 CSP 不放行 `src/` 需要的浏览器内 Babel）。

systemd 单元与 Caddy/nginx 的 TLS + WebSocket 反代配置见 `relay/README.md`。**TLS 必须**（配对码走 URL，令牌走 WS 握手的 query string——浏览器 WebSocket 无法自定义 header，只能如此；令牌不会落进 relay 自身日志，但反代层默认会把完整 URL 记进 access log，建议关掉或改 log_format 去 query，明文 HTTP 等于裸奔）。

## 桌面端设置

1. `Ctrl+,` → **Remote** → 填 relay 地址（如 `https://relay.example.com`）→ **Enable**。
2. 首次启用会生成设备身份；点"重新生成令牌"旁边的提示把令牌配进 relay 的 `devices`（令牌只显示一次，relay 只存哈希）。
3. 状态点变绿（online）即可配对。

## 配对手机

1. Settings → Remote → **配对新手机** → 屏幕出现二维码。
2. 手机相机扫码打开链接 → **电脑上弹出确认框** → 点"允许配对"。
3. 手机自动进入完整界面。配对码 5 分钟有效、只能用一次；手机令牌存在它自己的 localStorage。

丢手机：同页面"吊销"即可，立即生效。

## 多台电脑（Windows / macOS / Linux 同时在线）

同一个 relay 可以挂任意多台桌面端：每台各自 Enable 并把令牌配进 `devices`，各自审批自己的配对请求。

手机侧：

1. 对每台电脑分别扫一次码配对（Settings → Remote → 配对新手机）。配对记录按设备累积，不会互相覆盖。
2. 配对多台后，打开手机页面先进入**设备列表**：每台电脑显示名称、系统与实时在线状态（绿点在线），点一台在线的进入控制。
3. 进入后可随时切换：顶栏的设备名胶囊、或桌面端离线弹层上的"切换设备"，都会回到设备列表。切换会刷新一次页面（两台电脑是完全独立的会话状态）。
4. 列表里"遗忘"只删除手机上的本地配对；要彻底作废令牌，仍在对应桌面端"吊销"。

设备名称在各自桌面端 Settings → Remote 里设置（留空用计算机名），列表里显示的就是它。只配对了一台时手机直接进控制界面，和以前一样。

## 手机上能做什么

全部：聊天（流式）、发消息/图片、审批工具调用、切 tab、开新会话、git browser、终端、设置——和桌面同一个界面，窄屏自适应（抽屉式侧栏、全宽面板）。

手机浏览器没有的桌面能力会被明确拒绝（不会悄悄在电脑上弹窗）：原生文件对话框、系统剪贴板读取、窗口控制、自动更新安装。

## TLS

推荐 CA 证书（Caddy/nginx + 域名）。**自签证书也支持**：桌面端首次连接报 TLS 错误后，Settings → Remote 出现"信任证书"按钮——点一次即 TOFU 锁定（之后只认这一张证书，指纹可核对）；手机浏览器首次打开网址时"高级 → 继续前往"一次即可。

> 阿里云国内机器出站访问 Let's Encrypt / Buypass 的 ACME API 都不通（2026-10 实测），自签是这类环境的现实路径；有域名+通 ACME 时再换 CA 证书（改 nginx 配置即可，桌面端清掉 `remote.json` 的 `pinned_cert_pem` 恢复系统 CA 校验）。

## 安全说明

- 全链路 TLS；relay 只认令牌哈希，配对码一次性。
- relay 能看到转发的内容——它是你自己的服务器。需要零信任中继时再开 E2E（未实现，见 `docs/architecture/remote-control.md`）。
- 手机上的一切操作走桌面同一套审批策略（approval mode 不变）。
