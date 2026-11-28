# Paseo 插件

自用 Paseo 插件。各机的 `~/.local/lib` 就是本仓库的 checkout，daemon 的插件配置直接指向下面这些目录，不要随意改名或移动。

| 目录 | 插件 ID | 作用 | daemon 加载路径 |
|---|---|---|---|
| `paseo-bb-queue/` | `bb-queue` | 两种服务端排队：`bb ` 前缀在主 agent 及其子 agent 都空闲后发下一条；`cc ` 前缀按设置的分钟间隔定时发（积压时仍保持间隔）。两者共用一把发送锁，bb 优先；上一轮失败时都先停下，之后某一轮成功（如自动重试）就自动恢复。等子 agent 最长 60 分钟（可设置，0 为不限） | `paseo-bb-queue/plugin` |
| `paseo-auto-retry/` | `auto-retry` | 因超时、网络、限流或 provider 临时错误中断的轮次自动重试，每个请求最多 3 次 | `paseo-auto-retry` |
| `paseo-unread-count/` | `unread-count` | 侧边栏顶部显示所有已连接主机上完成/出错/等审批未看的会话数 | `paseo-unread-count` |

## 新机器安装

```bash
cd ~/.local/lib && git init -b master . && git remote add origin https://github.com/mjscjj/paseo-plugins.git
git fetch origin && git checkout -B master origin/master && git branch -u origin/master
for p in paseo-bb-queue/plugin paseo-auto-retry paseo-unread-count; do paseo plugin install ~/.local/lib/$p; done
```

- `~/.paseo/config.json` 里 `pluginsEnabled` 要是 `true`，否则插件全是 disabled。
- systemd 用户服务：写 `~/.config/systemd/user/paseo.service.d/bb-queue.conf`，内容为 `[Service]` 加 `Environment="NODE_OPTIONS=--import <家目录>/.local/lib/paseo-bb-queue/shim/register.mjs"`，再 `systemctl --user daemon-reload` 并在没有 agent 运行时重启 `paseo.service`。手动启动的 daemon 用 `NODE_OPTIONS=... paseo daemon start`。
- 自检：`node ~/.local/lib/paseo-bb-queue/scripts/verify-live.mjs` 输出 `{"ok":true,...}`。
- 不要在这里运行 `paseo-bb-queue/install.sh` / `uninstall.sh`，它们是给单独的 paseo-bb-queue 仓库用的，在本仓库里会拒绝执行（uninstall 只卸插件、不删代码）。

## 升级

`git -C ~/.local/lib pull`，然后 `paseo plugin reload <插件 ID>`（不需要重启 daemon）。

从带 cc-queue 的旧版升级：先 `paseo plugin remove cc-queue`（旧的 cc 待发消息和间隔设置不迁移），pull 后 reload bb-queue，再重启 daemon（shim 有改动）。

例外：`paseo-bb-queue/shim/` 由 drop-in 注入 daemon 进程，负责把 `bb ` / `cc ` 前缀消息转给 bb-queue 插件，改它需要重启 daemon（`paseo-bb-queue/scripts/restart-when-idle.sh`）。

机群（fleet）已于 2026-11-28 搬到独立仓库 https://github.com/mjscjj/fleet （各机 `~/.local/fleet`），不要再在这里改。
