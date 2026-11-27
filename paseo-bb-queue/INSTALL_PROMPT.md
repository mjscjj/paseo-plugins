# 安装提示词 / Install prompt

在 Paseo 客户端里切到要安装的机器，新开一个 Agent（Claude Code、Codex 等都可以），把下面整段贴进去。每台机器各做一次。

Open an agent on the target machine in the Paseo app and paste one of the blocks below. Do this once per machine.

## 中文

```text
请在这台机器上安装 Paseo 插件 BB Server Queue（仓库 https://github.com/mjscjj/paseo-bb-queue，公开仓库，不需要登录）。

1. 先读 https://raw.githubusercontent.com/mjscjj/paseo-bb-queue/master/README.md 的“工作原理和限制”，了解它会改哪些东西。
2. 运行：curl -fsSL https://raw.githubusercontent.com/mjscjj/paseo-bb-queue/master/install.sh | bash
   如果这台机器访问不了 raw.githubusercontent.com，就改成：
   git clone https://github.com/mjscjj/paseo-bb-queue.git ~/.local/lib/paseo-bb-queue && bash ~/.local/lib/paseo-bb-queue/install.sh
3. 把脚本输出的 [bb-queue] 行原样告诉我，并说明这台机器属于哪种情况（systemd / 命令行启动 / 桌面版托管）。
4. 如果输出里有 “Daemon restart scheduled”，你这一轮就直接结束：不要等待，不要自己重启 daemon。你结束后 daemon 会自动重启，这个会话也会恢复。
5. 等我回来说“验证”时，运行 node ~/.local/lib/paseo-bb-queue/scripts/verify-live.mjs，把结果告诉我。输出 {"ok":true,...} 就是装好了，然后告诉我用法：消息开头打 “bb ” 或用 /bb 命令就会进服务端队列，输入框上的「BB 排队」按钮可以管理队列。

出错时不要改 Paseo 的配置或源码，也不要反复重试，把错误原文和你的判断告诉我。
```

## English

```text
Install the Paseo plugin BB Server Queue on this machine (public repo https://github.com/mjscjj/paseo-bb-queue, no login needed).

1. Read the "How it works" section of https://raw.githubusercontent.com/mjscjj/paseo-bb-queue/master/README.md so you know what it changes.
2. Run: curl -fsSL https://raw.githubusercontent.com/mjscjj/paseo-bb-queue/master/install.sh | bash
   If raw.githubusercontent.com is unreachable, run instead:
   git clone https://github.com/mjscjj/paseo-bb-queue.git ~/.local/lib/paseo-bb-queue && bash ~/.local/lib/paseo-bb-queue/install.sh
3. Report the [bb-queue] output lines verbatim and say which case this machine is (systemd / CLI-started / desktop-managed).
4. If the output says "Daemon restart scheduled", end your turn right away: do not wait and do not restart the daemon yourself. The daemon restarts after your turn ends and this session comes back.
5. When I come back and say "verify", run node ~/.local/lib/paseo-bb-queue/scripts/verify-live.mjs and report the result. {"ok":true,...} means it works; then tell me how to use it: start a message with "bb " or use /bb to queue it on the daemon, and use the "BB 排队" composer button to manage the queue.

If anything fails, do not edit Paseo's config or source and do not retry in a loop; report the exact error and your diagnosis.
```
