# Remote Control — Mac → iPhone (Web)

通过 WebRTC 把 Mac 屏幕实时推送到 iPhone 浏览器（无需安装任何 App），并支持手机端的触摸/键盘操作远程控制 Mac。跨网络（不要求同一局域网）、PIN 码配对鉴权。

> 当前状态：**核心链路全部实现**（M1 观看 → M2 控制 → M3 安全加固 → M4 多屏/手势/可信设备 → M5 锁屏控制）。M1 已经在真机跑通，M2–M5 代码就绪，M5（锁屏控制）建议按下方「验收清单」做一轮真机验证。

## 功能总览

| 模块 | 能力 |
|---|---|
| **M1 观看** | Mac 屏幕画面实时推到 iPhone Safari，PIN 配对，黑屏/权限自检 |
| **M2 控制** | 触摸=鼠标、虚拟键盘输入、中文/日文等 IME 合成输入、右键、滚动、三指滑动切换桌面 |
| **M3 安全** | PIN 5 分钟过期 + 错误重试限流；TURN 一次性鉴权凭证动态发放；可信设备 token（密码免输连回） |
| **M4 体验** | 多显示器选择与切换（Mac 端 & 手机端都能切）、画面缩放/平移、iOS 键盘适配、桌面浏览器鼠标调试 |
| **M5 锁屏控制** | Mac 锁屏后仍可通过 macOS 自带「屏幕共享」+ noVNC 通道接入，接受系统登录密码认证 |

## 目录结构

```
remote/
├── mac-agent/            # Electron Mac 端应用 —— 屏幕捕获 + WebRTC + 输入注入 + VNC 桥接
│   ├── main.js           # 主进程：权限、屏幕列表、输入注入 IPC、VNC bridge 生命周期
│   ├── input-inject.js   # nut.js 鼠标/键盘注入（含多显示器坐标映射、AppleScript 切换桌面）
│   ├── vnc-bridge.js     # M5：把本地 127.0.0.1:5900 屏幕共享桥接到云端 /vnc-relay
│   ├── device-store.js   # 可信设备 token 存储（只存哈希）
│   └── renderer/         # PIN/状态/配置/锁屏模式/可信设备 UI
├── signaling-server/     # 部署在云服务器 —— WS信令 + PIN配对 + TURN凭证 + VNC relay + 静态托管
├── web-viewer/           # 纯网页，iPhone Safari 直接打开
│   ├── index.html/.js    # WebRTC 观看+控制页
│   ├── vnc.html/.js      # M5：锁屏控制页（noVNC 客户端）
│   └── vendor/novnc/     # noVNC 核心库（独立 vendored，无外链依赖）
└── infra/                # 云服务器一键部署（Nginx + TLS + coturn）
```

---

## 一、本地调试（同一台 Mac + 手机在同一 Wi-Fi）

三个组件都在本机/局域网跑起来即可验证基础链路。

### 1. 启动信令服务器

```bash
cd signaling-server
npm install
npm start
# ✅ Signaling server running on :8080
```

### 2. 启动 Mac Agent

```bash
cd mac-agent
npm install
npm start
```

首次启动会弹出一个小窗口显示 PIN 码。**务必检查窗口里的权限状态（每 5 秒自动刷新）**：
- **Screen Recording**：红点则点击「Enable」打开系统设置勾选权限，然后**重新运行 `npm start`**（macOS 要求重启进程才生效）
- **Accessibility**：控制能力（鼠标/键盘注入）依赖它，一并开启

Agent 窗口还提供：
- **Signal URL**：默认 `ws://localhost:8080`；手机访问时要改成 `ws://<Mac的局域网IP>:8080`（打包成 .app 后用这个输入框配置并保存，无需改环境变量）
- **Screen to Share**：多显示器时选择要推哪块屏（单屏自动隐藏）
- **Trusted Devices**：查看/吊销已配对的手机 token

### 3. 手机访问

手机连同一 Wi-Fi，用 Mac 局域网 IP 访问（不要用 `localhost`）:

```
http://<Mac的局域网IP>:8080?signal=ws://<Mac的局域网IP>:8080
```

> 查 Mac 局域网 IP：`ifconfig | grep "inet " | grep -v 127.0.0.1`

输入 Agent 窗口的 6 位 PIN 点击 Connect，几秒内看到 Mac 屏幕画面。**配对成功后手机端会自动保存设备 token，此后再次打开页面直接免密连回（24 小时有效）。**

### 手机操作说明

- **单指拖动** = 移动 Mac 鼠标；**轻点**（<300ms）= 左键点击
- **双指捏合** = 缩放画面（再放大状态下单指拖动是**平移画面**，轻点仍是点击）
- **双击** = 放大状态下的复位（scale=1 时双击是正常双击）
- **三指左右滑** = 切换 macOS 桌面/全屏空间
- **右下角 ⌨︎** = 呼出键盘输入文字（含中文拼音等 IME，候选词确认后才发送）
- **支持右键**：桌面浏览器测试时右键会发送右键点击；手机端长按右键手势尚未实现（代码注释里 M4 预留）

### 常见问题

| 现象 | 原因 | 解决 |
|---|---|---|
| Agent 窗口 PIN 一直是 `------` | 信令服务器没启动/连不上 | 确认 `signaling-server` 终端没报错，端口 8080 没被占用 |
| 手机输入 PIN 后报 "Invalid or expired PIN" | PIN 5 分钟过期 / 输错 | 看 Agent 窗口最新 PIN 重新输入；连续错 3 次会锁 30 秒 |
| 画面一直卡在 "Connecting…" | Screen Recording 权限没给 | 检查 Agent 窗口权限状态，给完权限后**必须重启 `npm start`** |
| 手机和 Mac 不在同一 Wi-Fi 连不上 | 本地模式没有 TURN 中转 | 走下方「云端部署」 |

---

## 二、云端部署（跨网络 / 互联网访问）

> 前提：一台云服务器（建议 Ubuntu 22.04+）和一个域名（DNS A 记录指向服务器公网 IP，例如 `remote.yourdomain.com`）。

### 1. 把代码传到云服务器

```bash
scp -r signaling-server web-viewer infra root@<服务器IP>:/opt/remote-control/
# mac-agent 只在 Mac 上运行，不需要传到服务器
```

### 2. 一键部署

```bash
ssh root@<服务器IP>
cd /opt/remote-control/infra
sudo bash deploy.sh remote.yourdomain.com
```

自动完成：安装 Node/Nginx/coturn/certbot → 注册 systemd 服务 → Nginx 反代 + Let's Encrypt 证书 → 配置 coturn 并生成随机密钥 → 开放端口（80, 443, 3478, 5349, 49152-65535/udp）。

> ⚠️ 云服务商（阿里云/腾讯云/AWS 等）还要去**安全组**控制台开同样的端口，光靠 ufw 不够。

### 3. 启动 Mac Agent（指向云端）

```bash
cd mac-agent
SIGNAL_URL=wss://remote.yourdomain.com npm start
```

### 4. 手机直接访问

任意网络（4G/5G/其他 Wi-Fi）下 Safari 打开 `https://remote.yourdomain.com`，输入 PIN 即可跨网络看到并控制 Mac。打洞失败时会自动走 TURN 中转（凭证由服务端动态签发，1 小时过期，无需在客户端埋长期密钥）。

---

## 三、锁屏控制模式（M5）

macOS 在锁屏状态下会阻止普通进程的屏幕捕获/输入注入（nut.js 和 desktopCapturer 都不可用）。M5 采用**双轨方案**：锁屏时改用 macOS 自己权限级别更高的「屏幕共享」服务（screensharingd，只监听 `127.0.0.1:5900` 不对外开放），通过 Mac Agent 的 `vnc-bridge.js` 把它桥接到云端的 `/vnc-relay` WebSocket 通道，手机端用 noVNC 客户端接入，**用 Mac 的系统登录密码认证**。

使用步骤：

1. **Mac 开启屏幕共享**：系统设置 → 通用 → 共享 → 打开「屏幕共享」；并保证锁屏后仍允许屏幕共享连接（墙纸与屏幕保护程序设置里可选）。
2. **打开 Agent 的 Lock-Screen Control Mode 开关**：Agent 窗口会生成一个 `…/vnc.html?code=…` 链接（一键「Copy Link」）。
3. **把链接发到手机并打开**：输入 Mac 的登录密码即可在锁屏状态下看到并控制 Mac 桌面。

> 设计说明：这个通道是**独立**于主 WebRTC 流程的（单独的 relay code、单独的 noVNC 页面），安全上依赖 macOS 自己的 VNC 密码（即系统密码），因此不为它叠第二层 PIN。
> **注意**：relay code 5 分钟过期且一次性；如果本地屏幕共享没开/连不上，手机端会收到明确错误（不会无限挂起），Agent 端会提示去开启屏幕共享。

---

## 四、里程碑与验收清单

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M1 | 观看链路（PIN 配对 → WebRTC 屏幕推送） | ✅ 已实现并真机验证 |
| M2 | 控制能力（鼠标/键盘/文字/IME） | ✅ 已实现，建议真机验证 |
| M3 | 安全加固（PIN 限流、TURN 动态凭证、可信设备） | ✅ 已实现 |
| M4 | 多显示器、缩放/平移、三指切桌面、键盘适配 | ✅ 已实现，建议真机验证 |
| M5 | 锁屏控制（VNC 双轨） | ✅ 已实现，**待真机验证** |

**M5 验收清单**：
- [ ] Mac 开启屏幕共享后，打开 Agent「Lock-Screen Control Mode」，手机打开生成的链接
- [ ] 锁上 Mac 屏幕，手机端输入 Mac 登录密码后能看到锁屏界面并能解锁/操作
- [ ] 关闭屏幕共享或中途断线时，手机端**不会卡死**，会显示明确错误
- [ ] relay code 用过后作废，重新生成链接才能再次连接
- [ ] 常规 WebRTC 通道（PIN 方式）与锁屏通道互不影响

## 五、打包 Mac Agent（可选）

```bash
cd mac-agent
npm run build   # 生成未签名 .app（debug）
npm run dist    # 生成 dmg
```

打包后的 .app 在系统设置里授权 Screen Recording / Accessibility 时，勾选的是「Remote Control Agent」而非 Terminal。首次运行后请**重新打开一次**应用让权限生效。electron-builder 配置里已排除不该进 asar 的原生模块（nut.js 相关 `asarUnpack`），并预留了发布到非 ARM Mac 的 x64 目标。

## 其它说明

- 数据面是 P2P WebRTC，信令服务器不承担视频流量；只有在 P2P 打洞失败时才用 TURN 中转。
- 手机端连接被 Mac 主动断开后，信令服务器会**就地轮换 PIN**（而不是销毁重建房间），避免刷新页面瞬间的「先断后建」窗口导致明明有 token 却还要重新输 PIN 的竞态。
- 目录里的引用（`input-inject.js`、`viewer.js` 等）都带多显示器坐标映射说明，改这块逻辑前先读文件头注释。