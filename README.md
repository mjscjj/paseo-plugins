# Paseo 插件

本机（dev4）daemon 加载的自用 Paseo 插件。仓库根是 `~/.local/lib`，daemon 的插件配置直接指向下面这些目录，不要随意改名或移动。

| 目录 | 插件 ID | 作用 | daemon 加载路径 |
|---|---|---|---|
| `paseo-bb-queue/` | `bb-queue` | `bb ` 前缀消息服务端排队；主 agent 及其子 agent 都空闲后才发下一条 | `paseo-bb-queue/plugin` |
| `paseo-cc-queue/` | `cc-queue` | `cc ` 前缀定时排队，按设置的分钟间隔依次入队 | `paseo-cc-queue/plugin` |
| `paseo-auto-retry/` | `auto-retry` | 因超时、网络、限流或 provider 临时错误中断的轮次自动重试 | `paseo-auto-retry` |
| `paseo-unread-count/` | `unread-count` | 侧边栏顶部显示所有已连接主机上完成/出错/等审批未看的会话数 | `paseo-unread-count` |

安装或改动后重载：`paseo plugin install <目录>` / `paseo plugin reload <插件 ID>`（不需要重启 daemon）。
