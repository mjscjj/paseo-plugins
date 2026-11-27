CC Timed Queue schedules messages on a fixed timetable.

- Start a message with `cc ` (or use `/cc <task>`). It is sent **N minutes later**; each further `cc` message is due N minutes after the previous pending one (14:00 → 14:30, 15:00, 15:30 …). With nothing pending, timing starts from now.
- Set N in **Settings → Plugins → CC Timed Queue** (default 30 minutes).
- When a message is due it waits until the agent and all of its subagents are idle, and lets a pending `bb` queue go first.
- Manage, edit, send now, pause or clear from the composer pill or the agent panel. The queue is stored at `~/.paseo/plugin-data/cc-queue/queues.json` and survives restarts; anything that came due while the daemon was down is sent once it is back.
