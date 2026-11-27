BB/CC Queue enables simultaneous frontend queueing and persistent backend queueing in Paseo.

## Dual Queue Workflow

- **Frontend Queue (native Paseo)**: Keep `Settings -> General -> Sending -> Default send` set to `Queue` (or long-press Send in `Steer` mode). Normal messages without `bb ` stay in Paseo's native client-side queue above the input box.
- **Backend Queue (`bb ` or `/bb`)**: Messages starting with `bb ` (case-insensitive, including mobile IME spaces) or sent via `/bb <task>` are automatically routed to the daemon's persistent FIFO queue (`~/.paseo/plugin-data/bb-queue/queues.json`) regardless of your `Default send` setting, surviving client disconnects and device switches.
- **Coordinated Drain**: When both queues have pending items, any active client's frontend queue drains first, and the backend queue automatically continues once the frontend queue finishes (or after a short timeout if the client disconnects).

## Timed Queue (`cc ` or `/cc`)

- Start a message with `cc ` (or use `/cc <task>`). It is sent **N minutes later**; each further `cc` message is due N minutes after the previous pending one (14:00 → 14:30, 15:00, 15:30 …). If one goes out late because the agent was busy, the rest move back by the same delay, so messages stay N minutes apart.
- Set N in **Settings → Plugins → BB/CC Queue → CC 定时间隔** (default 30 minutes). Queue file: `~/.paseo/plugin-data/bb-queue/cc-queues.json`.
- A due message waits until the agent and its subagents are idle, and lets a ready `bb` message go first. The two queues share one send lock, so one never cuts into the other's send.

## After a failed turn

Both queues hold when a turn fails, so they do not pile onto a broken agent or race the auto-retry plugin. When a later turn completes (an automatic retry, or your own message), they resume by themselves. A queue you paused by hand stays paused.
