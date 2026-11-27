import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface AutoRetryConfig {
  enabled: boolean;
  retryDelaysSeconds: number[];
  maxErrorAgeSeconds: number;
  scope: "all" | "workspace";
  cwdRoots: string[];
}

export interface AgentIncident {
  rootPromptKey: string;
  attempts: number;
  messageIds: string[];
  handledFailures: string[];
  lastAttemptAt?: string;
  lastOutcome?: "scheduled" | "dispatch-reserved" | "accepted" | "delivery-uncertain";
}

export interface ErrorObservation {
  agentId: string;
  category: string;
  retryable: boolean;
  source: string;
  message: string;
  observedAt: string;
}

export interface AutoRetryState {
  version: 1;
  agents: Record<string, AgentIncident>;
  observations: Record<string, ErrorObservation>;
}

export const DEFAULT_CONFIG: AutoRetryConfig = {
  enabled: true,
  retryDelaysSeconds: [15, 45, 120],
  maxErrorAgeSeconds: 3600,
  scope: "all",
  cwdRoots: [],
};

export function resolvePluginDataDir(): string {
  const paseoHome = process.env.PASEO_HOME ?? path.join(homedir(), ".paseo");
  return path.join(paseoHome, "plugin-data", "auto-retry");
}

function validateConfig(raw: unknown): AutoRetryConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid auto-retry config: expected JSON object");
  }
  const obj = raw as Record<string, unknown>;
  const enabled = typeof obj.enabled === "boolean" ? obj.enabled : DEFAULT_CONFIG.enabled;
  const scope = obj.scope === "workspace" ? "workspace" : obj.scope === "all" ? "all" : null;
  if (!scope) {
    throw new Error(`Invalid auto-retry config: scope must be 'all' or 'workspace'`);
  }
  const delays = obj.retryDelaysSeconds;
  if (
    !Array.isArray(delays) ||
    delays.length < 1 ||
    delays.length > 5 ||
    delays.some((d) => typeof d !== "number" || !Number.isFinite(d) || d < 5)
  ) {
    throw new Error(
      "Invalid auto-retry config: retryDelaysSeconds must be 1..5 numbers >= 5",
    );
  }
  const maxErrorAgeSeconds = obj.maxErrorAgeSeconds;
  if (
    typeof maxErrorAgeSeconds !== "number" ||
    !Number.isFinite(maxErrorAgeSeconds) ||
    maxErrorAgeSeconds <= 0
  ) {
    throw new Error("Invalid auto-retry config: maxErrorAgeSeconds must be > 0");
  }
  const cwdRoots = obj.cwdRoots;
  if (!Array.isArray(cwdRoots) || cwdRoots.some((r) => typeof r !== "string")) {
    throw new Error("Invalid auto-retry config: cwdRoots must be string[]");
  }
  return {
    enabled,
    retryDelaysSeconds: delays,
    maxErrorAgeSeconds,
    scope,
    cwdRoots,
  };
}

export class AutoRetryStore {
  readonly dataDir: string;
  readonly configPath: string;
  readonly statePath: string;
  readonly eventsPath: string;
  private state: AutoRetryState;

  constructor(dataDir: string = resolvePluginDataDir()) {
    this.dataDir = dataDir;
    this.configPath = path.join(dataDir, "config.json");
    this.statePath = path.join(dataDir, "state.json");
    this.eventsPath = path.join(dataDir, "events.jsonl");
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    this.ensureDefaultConfig();
    this.state = this.loadState();
  }

  private ensureDefaultConfig(): void {
    if (existsSync(this.configPath)) return;
    writeFileSync(this.configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", {
      mode: 0o600,
    });
  }

  readConfig(): AutoRetryConfig {
    const raw = JSON.parse(readFileSync(this.configPath, "utf8"));
    return validateConfig(raw);
  }

  private loadState(): AutoRetryState {
    if (!existsSync(this.statePath)) {
      return { version: 1, agents: {}, observations: {} };
    }
    const parsed = JSON.parse(readFileSync(this.statePath, "utf8"));
    if (
      !parsed ||
      parsed.version !== 1 ||
      typeof parsed.agents !== "object" ||
      parsed.agents === null
    ) {
      // Fail fast: corrupt state must never silently reset retry budgets.
      throw new Error(`Corrupt auto-retry state file: ${this.statePath}`);
    }
    return {
      version: 1,
      agents: parsed.agents as Record<string, AgentIncident>,
      observations: (parsed.observations ?? {}) as Record<string, ErrorObservation>,
    };
  }

  getState(): AutoRetryState {
    return this.state;
  }

  saveState(): void {
    const tmp = `${this.statePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.statePath);
  }

  recordObservation(key: string, obs: ErrorObservation): boolean {
    if (this.state.observations[key]) return false;
    this.state.observations[key] = obs;
    const keys = Object.keys(this.state.observations);
    if (keys.length > 300) {
      for (const oldKey of keys.slice(0, keys.length - 300)) {
        delete this.state.observations[oldKey];
      }
    }
    this.saveState();
    return true;
  }

  purgeAgent(agentId: string): void {
    if (this.state.agents[agentId]) {
      delete this.state.agents[agentId];
      this.saveState();
    }
  }

  appendEvent(event: Record<string, unknown>, maxBytes = 1024 * 1024): void {
    const entry = { at: new Date().toISOString(), ...event };
    try {
      if (existsSync(this.eventsPath) && statSync(this.eventsPath).size >= maxBytes) {
        if (existsSync(`${this.eventsPath}.1`)) {
          renameSync(`${this.eventsPath}.1`, `${this.eventsPath}.2`);
        }
        renameSync(this.eventsPath, `${this.eventsPath}.1`);
      }
      appendFileSync(this.eventsPath, JSON.stringify(entry) + "\n", { mode: 0o600 });
    } catch (err) {
      console.error("[auto-retry] failed to write event log:", err);
    }
    console.log(`[auto-retry] ${JSON.stringify(entry)}`);
  }
}
