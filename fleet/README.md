# fleet：机群注册中心和派活记录

几台机器组成一个机群：一台中心登记所有机器、知道怎么连到每台的 Paseo；任何人或任何 Agent 都通过中心把活派给某台机器的默认 Agent，每个活记成中心上的一个 Markdown 文件，可以追问、叫停。执行完全交给 Paseo，这里只补登记、连法和记录。只用 Python 标准库。

## 组成

| 文件 | 在哪跑 | 作用 |
|---|---|---|
| `registry.py` | 只在中心 | HTTP 服务（6780，IPv4+IPv6）：节点登记与心跳、派活 / 追问 / 叫停接口、任务记录、状态页 |
| `fleet` | 每台机器 | 命令行：`join` / `leave` / `nodes` / `run` / `reply` / `stop` / `ls` / `show` / `report` |
| `skills/fleet/SKILL.md` | 每台机器 | 告诉 Agent 怎么看机群、怎么派活、收到机群任务怎么交结果；`join` 时软链进 `~/.agents/skills`、`~/.claude/skills`、`~/.codex/skills`、`~/.trae/skills`（存在的才链） |
| `systemd/fleet-registry.service` | 只在中心 | 用户服务 |
| `systemd/fleet-tunnel@.service` | 只在中心 | 给连不到中心的机器开反向 SSH 隧道，让它在自己的 `127.0.0.1:6780` 访问中心 |

## 加入和心跳

每台机器（包括中心自己）`fleet join` 后每 2 分钟上报一次（Linux 用 crontab，Mac 用 launchd）：IP、Paseo 的监听地址和配对链接、可用的 CLI、默认 Agent、在跑几个。IP 会变的机器（WiFi）靠这个保持最新；6 分钟没心跳算离线。

连不到中心、但中心连得到的机器（如公网机器）：中心开一条反向 SSH 隧道 `fleet-tunnel@<ssh 别名>`，那台机器用 `http://127.0.0.1:6780` 加入，之后和别的机器完全一样。

## 中心怎么连到每台的 Paseo

- 中心自己：本机 daemon。
- 对方 Paseo 监听 `0.0.0.0` 且中心连得通：直连 `IP:端口`。
- 其他（只监听本机、IP 会变、连不进来的）：用它上报的配对链接走 Paseo 中转，IP 变了也不影响。

## 派活和记录

`fleet run <机器> "任务"` → 中心写 `~/fleet/tasks/<日期>/<编号>-<机器>-<标题>.md`（`queued`）→ 在目标 daemon 上用它的默认 Agent 创建一个 Agent，工作目录默认是对方的 `~/fleet/work`（`running`，记下 Paseo agent id）→ 每 20 秒看一次，结束后把 Agent 最后一条消息写进「结果」（`done` / `failed`；等审批时是 `blocked`）。中心重启后会接着跟进没结束的任务。

- `fleet reply <编号> "..."`：干完后接着问同一个 Agent。上一轮结果和这次追问移进「往来」，新结果写进「结果」，`rounds` 加一。还在干的活不能追问，先等或者 `fleet stop`。
- `fleet stop <编号>`：停掉对方的 Agent，状态 `stopped`。

任务文件开头是 `id / title / from / to / agent / status / created / started / finished / rounds / cwd / paseo_agent`，正文是「任务」「往来」（有追问才有）「结果」。`from` 是派活机器名，从 Paseo Agent 里派时带上那个 Agent 的短 id。

## 安装

各机 `~/.local/lib` 是本仓库的 checkout，`git -C ~/.local/lib pull` 即可拿到 `fleet/`。

中心：

```bash
mkdir -p ~/.config/systemd/user && ln -sf ~/.local/lib/fleet/systemd/fleet-registry.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now fleet-registry
ln -sf ~/.local/lib/fleet/fleet ~/.local/bin/fleet
fleet join http://<中心IP>:6780 --name <名字> --agent <provider>/<model> --mode <权限模式>
```

其他机器：

```bash
ln -sf ~/.local/lib/fleet/fleet ~/.local/bin/fleet
fleet join http://<中心IP>:6780 --name <名字> --agent traecli/gpt-6.2-sol/high --mode bypass_permissions
```

连不到中心的机器：中心先配好免密 SSH 和别名，`ln -sf ~/.local/lib/fleet/systemd/fleet-tunnel@.service ~/.config/systemd/user/ && systemctl --user enable --now fleet-tunnel@<别名>`，那台机器再用 `http://127.0.0.1:6780` join。

`--agent` 的模型名按那台机器 `paseo provider models <provider>` 列出的写（Codex 的模型名可能带机器自己的前缀）。`paseo` 不在常见位置时加 `--paseo <完整路径>`。改默认 Agent 就重新 `fleet join` 同一个名字。离开用 `fleet leave`。

## 排障

- `fleet nodes` 里离线：看那台机器的 `~/fleet/report.log`，或手动 `fleet report`。
- 派出去一直 `queued` 或 `failed`：中心日志 `journalctl --user -u fleet-registry`；连法是 relay 时先在中心试 `paseo ls --host '<配对链接>'`。
- 数据都在中心 `~/fleet/`：`nodes.json`（节点表）、`counter`、`tasks/`。
