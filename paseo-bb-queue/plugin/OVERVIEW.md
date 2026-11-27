BB Server Queue enables simultaneous frontend queueing and persistent backend queueing in Paseo.

## Dual Queue Workflow

- **Frontend Queue (native Paseo)**: Keep `Settings -> General -> Sending -> Default send` set to `Queue` (or long-press Send in `Steer` mode). Normal messages without `bb ` stay in Paseo's native client-side queue above the input box.
- **Backend Queue (`bb ` or `/bb`)**: Messages starting with `bb ` (case-insensitive, including mobile IME spaces) or sent via `/bb <task>` are automatically routed to the daemon's persistent FIFO queue (`~/.paseo/plugin-data/bb-queue/queues.json`) regardless of your `Default send` setting, surviving client disconnects and device switches.
- **Coordinated Drain**: When both queues have pending items, any active client's frontend queue drains first, and the backend queue automatically continues once the frontend queue finishes (or after a short timeout if the client disconnects).
