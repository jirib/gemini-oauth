import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

export type DaemonState = {
  pid: number;
  host: string;
  port: number;
  url: string;
  startedAt: string;
  logFile: string;
  authFile?: string;
};

export const DAEMON_HOME = join(homedir(), ".gemini", "oauth-proxy");
export const DAEMON_STATE_FILE = join(DAEMON_HOME, "state.json");
export const DAEMON_LOG_FILE = join(DAEMON_HOME, "server.log");
export const DAEMON_PID_FILE = join(DAEMON_HOME, "server.pid");

export function ensureDaemonHome(): void {
  mkdirSync(DAEMON_HOME, { recursive: true, mode: 0o700 });
}

export function readDaemonState(): DaemonState | null {
  try {
    if (!existsSync(DAEMON_STATE_FILE)) return null;
    const raw = JSON.parse(
      readFileSync(DAEMON_STATE_FILE, "utf8"),
    ) as DaemonState;
    if (!raw || typeof raw.pid !== "number") return null;
    return raw;
  } catch {
    return null;
  }
}

export function writeDaemonState(state: DaemonState): void {
  ensureDaemonHome();
  writeFileSync(DAEMON_STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  writeFileSync(DAEMON_PID_FILE, `${state.pid}\n`, { mode: 0o600 });
}

export function clearDaemonState(): void {
  for (const file of [DAEMON_STATE_FILE, DAEMON_PID_FILE]) {
    try {
      if (existsSync(file)) unlinkSync(file);
    } catch {
      // ignore
    }
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function getRunningDaemon(): DaemonState | null {
  const state = readDaemonState();
  if (!state) return null;
  if (!isProcessAlive(state.pid)) {
    clearDaemonState();
    return null;
  }
  return state;
}

/**
 * Spawn a detached child that runs the same CLI in foreground server mode.
 */
export function spawnDetachedServer(opts: {
  cliEntry: string;
  nodeArgs?: string[];
  serveArgs: string[];
  host: string;
  port: number;
  authFile?: string;
  logFile?: string;
}): DaemonState {
  ensureDaemonHome();
  const existing = getRunningDaemon();
  if (existing) {
    throw new Error(
      `Already running (pid ${existing.pid}) at ${existing.url}. Stop it first: agy-oauth stop`,
    );
  }

  const logFile = opts.logFile ?? DAEMON_LOG_FILE;
  const logFd = openSync(logFile, "a");

  const child = spawn(
    process.execPath,
    [
      ...(opts.nodeArgs ?? []),
      opts.cliEntry,
      "serve",
      "--foreground",
      ...opts.serveArgs,
    ],
    {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        AGY_OAUTH_DAEMON: "1",
      },
    },
  );

  if (!child.pid) {
    throw new Error("Failed to spawn detached server process");
  }

  const state: DaemonState = {
    pid: child.pid,
    host: opts.host,
    port: opts.port,
    url: `http://${opts.host}:${opts.port}/v1`,
    startedAt: new Date().toISOString(),
    logFile,
    authFile: opts.authFile,
  };
  writeDaemonState(state);
  child.unref();
  return state;
}

export async function stopDaemon(
  timeoutMs = 8000,
): Promise<DaemonState | null> {
  const state = getRunningDaemon();
  if (!state) {
    clearDaemonState();
    return null;
  }

  try {
    process.kill(state.pid, "SIGTERM");
  } catch {
    clearDaemonState();
    return state;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(state.pid)) {
      clearDaemonState();
      return state;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  try {
    process.kill(state.pid, "SIGKILL");
  } catch {
    // ignore
  }
  clearDaemonState();
  return state;
}
