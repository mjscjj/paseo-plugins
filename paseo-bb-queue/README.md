# BB Server Queue for Paseo

[中文](#中文) · [English](#english)

在 [Paseo](https://paseo.sh) 里给 Agent 发消息时，开头打 `bb `，这条消息就进**服务端**持久化队列：Agent 正忙就排队，当前轮结束后按顺序自动发出。队列存在 daemon 上，关掉客户端、换手机或电脑继续发都不会丢。

Start a Paseo message with `bb ` and it goes into a **daemon-side** persistent FIFO queue: if the agent is busy it waits, and it is sent automatically when the current turn ends. The queue lives on the daemon, so it survives closing the app or switching devices.

---

## 中文

### 一键安装

在要安装的机器上（装了 Paseo、daemon 正在运行）执行：

```bash
curl -fsSL https://raw.githubusercontent.com/mjscjj/paseo-bb-queue/master/install.sh | bash
```

脚本会：

1. 把仓库拉到 `~/.local/lib/paseo-bb-queue`（已有就更新）；
2. 用 `paseo plugin install` 安装插件本体（已安装就热加载）；
3. 给 daemon 挂上消息拦截垫片（systemd 机器写 `~/.config/systemd/user/paseo.service.d/bb-queue.conf`）；
4. 等到没有 Agent 在跑时自动重启一次 daemon，让垫片生效。垫片已经是最新时不会重启。

再执行一次同一条命令就是升级。

### 用 Agent 安装（推荐给多台机器）

在 Paseo 客户端里切到目标机器，新开一个 Agent，把 [INSTALL_PROMPT.md](INSTALL_PROMPT.md) 里的提示词整段贴进去。Agent 会自己完成安装，daemon 在它这轮结束后重启。回来跟它说一声“验证”，它会跑检查并报告结果。

Paseo 里连了几台机器，就在每台上各做一次。

### 怎么用

| 操作 | 效果 |
|---|---|
| `bb 帮我跑一下测试` | 进服务端队列。Agent 空闲就马上发，忙就排队（大小写不限，手机输入法的空格也认） |
| `/bb 帮我跑一下测试` | 同上，用斜杠命令 |
| 输入框上的「BB 排队」按钮 | 查看、编辑、上下移动、立即发送、撤回、暂停/恢复、清空当前 Agent 的队列 |
| 侧边栏「BB 服务端队列总览」 | 看所有 Agent 的队列 |
| 不带 `bb ` 的普通消息 | 走 Paseo 自带的前端队列，不受影响 |

建议把 `设置 → 通用 → 发送 → 默认发送` 设成「排队」。两个队列同时有消息时，先发完前端队列，再接着发服务端队列。

### 验证

```bash
node ~/.local/lib/paseo-bb-queue/scripts/verify-live.mjs
```

输出 `{"ok":true,...}` 就说明插件和垫片都在工作。

### 卸载

```bash
bash ~/.local/lib/paseo-bb-queue/uninstall.sh
```

会移除插件和 systemd 配置，在 daemon 空闲时重启，再删掉代码目录。已排队的消息留在 `~/.paseo/plugin-data/bb-queue/`，不要了可以手动删。

### 工作原理和限制

由两部分组成：

- `plugin/`：标准 Paseo 插件。负责服务端队列、调度和存盘，以及输入框按钮、面板、`/bb` 命令。
- `shim/`：daemon 垫片，通过 `NODE_OPTIONS=--import .../shim/register.mjs` 加载。它把客户端发来的 `bb ` 开头的消息改交给插件排队。Paseo 插件接口目前没有“消息发出前”的钩子，所以需要垫片。

不同机器的情况：

| daemon 运行方式 | 支持程度 |
|---|---|
| Linux，systemd 用户服务 `paseo.service` | 完整支持（已验证） |
| 命令行启动（`paseo daemon start`，没有 systemd） | 完整支持。安装脚本会用 `NODE_OPTIONS=... paseo daemon start` 重启 daemon；机器重启后要自己带上这个变量启动 |
| Paseo 桌面版托管的 daemon | 只有面板模式：面板和 `/bb` 可用，`bb ` 前缀只在 Agent 忙、默认发送为「排队」时生效 |

垫片依赖 Paseo 内部的通信实现，Paseo 大版本升级后可能失效。失效时 daemon 日志里会出现 `[bb-queue-shim] ERROR`，这时 `bb ` 前缀会退化成普通消息，面板和 `/bb` 仍然可用。已在 Paseo 0.17.4 上测试，需要 Node.js ≥ 20.6。

### 可调参数

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `BB_QUEUE_RESTART` | `idle` | `idle` 等空闲后重启；`now` 立即重启；`no` 不重启，只打印该怎么做 |
| `BB_QUEUE_REF` | `master` | 安装哪个分支或 tag |
| `BB_QUEUE_DIR` | `~/.local/lib/paseo-bb-queue` | 安装目录 |
| `BB_QUEUE_REPO` | 本仓库 | 从 fork 安装时改这个 |
| `PASEO_HOME` | `~/.paseo` | Paseo 数据目录 |

例：`curl -fsSL .../install.sh | BB_QUEUE_RESTART=no bash`

### 开发

```bash
npm test   # 单元测试 + 起一个隔离的 Paseo daemon 做端到端测试，需要本机装有 paseo
```

---

## English

### Install

On the machine that runs the Paseo daemon:

```bash
curl -fsSL https://raw.githubusercontent.com/mjscjj/paseo-bb-queue/master/install.sh | bash
```

It clones this repo to `~/.local/lib/paseo-bb-queue`, installs the plugin with `paseo plugin install`, attaches the daemon shim (a systemd drop-in on systemd hosts), and restarts the daemon once no agent is running. Run it again to update.

To install on several machines, open an agent on each host in the Paseo app and paste the prompt from [INSTALL_PROMPT.md](INSTALL_PROMPT.md).

### Use

- `bb <message>` or `/bb <message>`: queue on the daemon; sent immediately when the agent is idle, otherwise after the current turn.
- The **BB 排队** composer button: view, edit, reorder, send now, remove, pause or clear the agent's queue. The sidebar view shows all queues.
- Messages without `bb ` use Paseo's own client queue as before. Set *Settings → General → Sending → Default send* to *Queue*; when both queues have items, the client queue drains first.

### Verify, uninstall

```bash
node ~/.local/lib/paseo-bb-queue/scripts/verify-live.mjs   # prints {"ok":true,...}
bash ~/.local/lib/paseo-bb-queue/uninstall.sh
```

### How it works

`plugin/` is a regular Paseo plugin (queue store, scheduler, UI, `/bb`). `shim/` is loaded into the daemon through `NODE_OPTIONS=--import` and reroutes `bb `-prefixed sends to the plugin, because the plugin API has no pre-send hook yet. Full support on systemd and CLI-started daemons; desktop-managed daemons get panel mode only. The shim relies on Paseo internals and was tested on Paseo 0.17.4 (Node.js ≥ 20.6). If it breaks after a Paseo upgrade, the daemon log shows `[bb-queue-shim] ERROR` and `bb ` messages are sent as normal messages.

Options: `BB_QUEUE_RESTART=idle|now|no`, `BB_QUEUE_REF`, `BB_QUEUE_DIR`, `BB_QUEUE_REPO`, `PASEO_HOME`.

## License

MIT
