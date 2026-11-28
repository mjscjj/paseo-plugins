# fleet：机群注册中心和派活记录

几台机器组成一个机群：一台中心登记所有机器、知道怎么连到每台的 Paseo；任何人或任何 Agent 都通过中心把活派给某台机器的默认 Agent，每个活记成中心上的一个 Markdown 文件。执行完全交给 Paseo，这里只补登记、连法和记录。只用 Python 标准库。

## 组成

| 文件 | 在哪跑 | 作用 |
|---|---|---|
| `registry.py` | 只在中心 | HTTP 服务（默认 6780）：节点登记与心跳、派活接口、任务记录、状态页；每分钟用 SSH 同步边缘节点 |
| `fleet` | 每台机器 | 命令行：`join` / `leave` / `nodes` / `run` / `ls` / `show` / `report` / `outbox` / `edge-add` |
| `skills/fleet/SKILL.md` | 每台机器 | 告诉 Agent 怎么看机群、怎么派活、收到机群任务怎么交结果；`join` 时软链进 `~/.agents/skills`、`~/.claude/skills`、`~/.codex/skills`、`~/.trae/skills`（存在的才链） |
| `systemd/fleet-registry.service` | 只在中心 | 用户服务 |

## 三种节点

- **中心**：跑 `registry.py`，它自己也用 `fleet join` 作为普通节点加入。
- **普通节点**：能连到中心。`fleet join` 后每 2 分钟上报一次（Linux 用 crontab，Mac 用 launchd）：IP、Paseo 的监听地址和配对链接、可用的 CLI、默认 Agent、在跑几个。IP 会变的机器（WiFi）靠这个保持最新。
- **边缘节点**：中心连得到它、它连不到中心（如公网机器）。`fleet join --edge` 只写本地配置；在中心 `fleet edge-add` 登记 SSH 登录方式后，中心每分钟上去取一次上报和待发任务，并把通讯录和它派出的任务记录推回去。

## 中心怎么连到每台的 Paseo

- 中心自己：本机 daemon。
- 对方 Paseo 监听 `0.0.0.0` 且中心连得通：直连 `IP:端口`。
- 其他（只监听本机、IP 会变、连不进来的）：用它上报的配对链接走 Paseo 中转，IP 变了也不影响。

## 派活和记录

`fleet run <机器> "任务"` → 中心写 `~/fleet/tasks/<日期>/<编号>-<机器>-<标题>.md`（状态 `queued`）→ 在目标 daemon 上用它的默认 Agent 创建一个 Agent（`running`，记下 Paseo agent id）→ 每 20 秒看一次，结束后把 Agent 最后一条消息写进「结果」（`done` / `failed`；等审批时是 `blocked`）。中心重启后会接着跟进没结束的任务。

任务文件开头是 `id / title / from / to / agent / status / created / started / finished / cwd / paseo_agent`，正文是「任务」和「结果」两节。`from` 是派活机器名，从 Paseo Agent 里派时带上那个 Agent 的短 id。

## 安装

各机 `~/.local/lib` 是本仓库的 checkout，`git -C ~/.local/lib pull` 即可拿到 `fleet/`。

中心：

```bash
mkdir -p ~/.config/systemd/user && ln -sf ~/.local/lib/fleet/systemd/fleet-registry.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now fleet-registry
ln -sf ~/.local/lib/fleet/fleet ~/.local/bin/fleet
fleet join http://<中心IP>:6780 --name <名字> --agent <provider>/<model> --mode <权限模式>
```

普通节点：

```bash
ln -sf ~/.local/lib/fleet/fleet ~/.local/bin/fleet
fleet join http://<中心IP>:6780 --name <名字> --agent traecli/gpt-6.2-sol/high --mode bypass_permissions
```

边缘节点：在它上面 `fleet join http://<中心IP>:6780 --name <名字> --agent ... --edge`，再在中心 `fleet edge-add <名字> --ssh 'ssh -o BatchMode=yes <账号>@<地址>'`（中心要能免密登录它）。

`--agent` 的模型名按那台机器 `paseo` 里列出的写（Codex 的模型名带机器自己的前缀）。改默认 Agent 就重新 `fleet join` 同一个名字。离开用 `fleet leave`。

## 排障

- `fleet nodes` 里离线：看那台机器的 `~/fleet/report.log`，或手动 `fleet report`。
- 派出去一直 `queued` 或 `failed`：中心日志 `journalctl --user -u fleet-registry`；连法是 relay 时先在中心试 `paseo ls --host '<配对链接>'`。
- 数据都在中心 `~/fleet/`：`nodes.json`、`counter`、`tasks/`。
