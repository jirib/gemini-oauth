#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { GeminiAuthStore } from "./auth.js";
import {
  DEFAULT_AUTH_FILE,
  DEFAULT_HOST,
  DEFAULT_PORT,
  PACKAGE_NAME,
  PACKAGE_VERSION,
} from "./constants.js";
import {
  DAEMON_LOG_FILE,
  getRunningDaemon,
  spawnDetachedServer,
  stopDaemon,
} from "./daemon.js";
import { login } from "./oauth-login.js";
import { startAgyOAuthServer } from "./server.js";

const help = `
${PACKAGE_NAME} v${PACKAGE_VERSION}

Turn your Gemini CLI (Google Code Assist OAuth) session into a local
OpenAI-compatible API — the Gemini analogue of openai-oauth / grok-oauth.

Usage:
  agy-oauth [serve|start] [options]   Start local OpenAI-compatible proxy
  agy-oauth stop                      Stop detached background server
  agy-oauth status                    Auth + server process status
  agy-oauth logs [--follow]           Show detached server log
  agy-oauth login [options]           Sign in via browser (or device/headless)
  agy-oauth logout                    Clear stored credentials
  agy-oauth help                      Show this help

Serve options:
  --host <host>          Bind address (default: ${DEFAULT_HOST})
  --port <port>          Bind port (default: ${DEFAULT_PORT}, or $AGY_OAUTH_PORT)
  --auth-file <path>     Path to oauth_creds.json (default: ${DEFAULT_AUTH_FILE})
  --models <ids>         Comma-separated model allowlist
  --project <id>         Override GCP / Code Assist project id
  --detach, -d           Run in background (daemon)
  --foreground           Force foreground (used by daemon child)
  --force                Start even if a detached server is already running
  --no-open              (login) Print URL only, do not open browser
  --device               (login) Headless code paste flow (SSH)
  --timeout-ms <ms>      (login) Login timeout
  --follow, -f           (logs) Follow log file

Port notes:
  Default port is ${DEFAULT_PORT}. Env: AGY_OAUTH_PORT=18080 agy-oauth

Examples:
  agy-oauth --detach --port 18080
  agy-oauth status
  curl http://127.0.0.1:18080/v1/models
  agy-oauth stop
`.trim();

const isPortOpen = (
  host: string,
  port: number,
  timeoutMs = 400,
): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (open: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });

const resolveDefaultPort = (): number => {
  const fromEnv = process.env.AGY_OAUTH_PORT;
  if (fromEnv) {
    const n = Number(fromEnv);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_PORT;
};

const print = (msg: string) => process.stdout.write(`${msg}\n`);
const fail = (msg: string, code = 1): never => {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
};

const cliEntry = fileURLToPath(import.meta.url);

async function cmdAuthStatus(authFile: string, project?: string): Promise<void> {
  const store = new GeminiAuthStore({
    authFilePath: authFile,
    projectId: project,
  });
  if (!store.hasCredentials()) {
    print(`Auth: not signed in (${authFile})`);
    print(`Run: gemini   or   agy-oauth login`);
  } else {
    try {
      const session = await store.getSession();
      print(`Auth: signed in`);
      if (session.email) print(`  email:      ${session.email}`);
      if (session.expiresAt)
        print(`  expires_at: ${session.expiresAt.toISOString()}`);
      print(`  auth_file:  ${authFile}`);
      print(
        `  token:      ${session.accessToken.slice(0, 12)}… (${session.accessToken.length} chars)`,
      );
      try {
        const projectId = await store.ensureProjectId();
        print(`  project:    ${projectId}`);
      } catch (err) {
        print(
          `  project:    (unresolved) ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } catch (err) {
      print(`Auth: error — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const daemon = getRunningDaemon();
  if (daemon) {
    print(`Server: running`);
    print(`  pid:        ${daemon.pid}`);
    print(`  url:        ${daemon.url}`);
    print(`  started_at: ${daemon.startedAt}`);
    print(`  log_file:   ${daemon.logFile}`);
  } else {
    print(`Server: not running (detached)`);
    print(`  start with: agy-oauth --detach`);
  }
}

async function cmdLogin(opts: {
  authFile: string;
  open: boolean;
  device: boolean;
  timeoutMs?: number;
  project?: string;
}): Promise<void> {
  const store = new GeminiAuthStore({
    authFilePath: opts.authFile,
    projectId: opts.project,
  });
  await login({
    store,
    open: opts.open,
    device: opts.device,
    timeoutMs: opts.timeoutMs,
    onMessage: print,
  });
}

function printExistingServer(existing: {
  pid: number;
  url: string;
  port: number;
  logFile: string;
  startedAt: string;
}): void {
  print(`Server already running (detached daemon)`);
  print(`  pid:        ${existing.pid}`);
  print(`  url:        ${existing.url}`);
  print(`  port:       ${existing.port}`);
  print(`  started_at: ${existing.startedAt}`);
  print(`  log_file:   ${existing.logFile}`);
  print(``);
  print(`Use this base URL (not the default ${DEFAULT_PORT}):`);
  print(`  ${existing.url}`);
  print(``);
  print(`  agy-oauth status`);
  print(`  agy-oauth logs --follow`);
  print(`  agy-oauth stop`);
  print(`  agy-oauth --force …     # start a second instance anyway`);
}

async function cmdServe(opts: {
  host: string;
  port: number;
  authFile: string;
  models?: string[];
  project?: string;
  detach: boolean;
  foreground: boolean;
  force: boolean;
  portExplicit: boolean;
  rawServeArgs: string[];
}): Promise<void> {
  const isDaemonChild =
    opts.foreground || process.env.AGY_OAUTH_DAEMON === "1";

  if (!isDaemonChild && !opts.force) {
    const existing = getRunningDaemon();
    if (existing) {
      printExistingServer(existing);
      if (opts.port !== existing.port) {
        print(``);
        print(
          `Note: you requested port ${opts.port}, but the daemon is on ${existing.port}.`,
        );
        print(
          `Stop it first (\`agy-oauth stop\`) if you want port ${opts.port}.`,
        );
      }
      return;
    }
  }

  if (opts.detach && !opts.foreground) {
    const store = new GeminiAuthStore({
      authFilePath: opts.authFile,
      projectId: opts.project,
    });
    if (!store.hasCredentials()) {
      print(`No credentials found. Run login first:\n  agy-oauth login\n`);
      fail("Cannot start detached server without credentials.");
    }
    await store.getSession();

    const state = spawnDetachedServer({
      cliEntry,
      serveArgs: opts.rawServeArgs,
      host: opts.host,
      port: opts.port,
      authFile: opts.authFile,
    });

    await new Promise((r) => setTimeout(r, 800));
    const still = getRunningDaemon();
    if (!still) {
      const log = existsSync(DAEMON_LOG_FILE)
        ? readFileSync(DAEMON_LOG_FILE, "utf8").slice(-1500)
        : "";
      fail(`Server failed to stay up. Check logs: agy-oauth logs\n${log}`);
    }

    print(`Gemini OAuth proxy started in background`);
    print(`  pid: ${state.pid}`);
    print(`  url: ${state.url}`);
    print(`  port: ${state.port}`);
    print(`  log: ${state.logFile}`);
    print(``);
    print(`  agy-oauth status`);
    print(`  agy-oauth logs --follow`);
    print(`  agy-oauth stop`);
    return;
  }

  if (await isPortOpen(opts.host, opts.port)) {
    const existing = getRunningDaemon();
    if (existing && existing.port === opts.port) {
      printExistingServer(existing);
      return;
    }
    fail(
      `Port ${opts.host}:${opts.port} is already in use.\n` +
        `  lsof -nP -iTCP:${opts.port} -sTCP:LISTEN\n` +
        `  Or: agy-oauth status / agy-oauth stop`,
    );
  }

  const store = new GeminiAuthStore({
    authFilePath: opts.authFile,
    projectId: opts.project,
  });
  if (!store.hasCredentials()) {
    if (process.env.AGY_OAUTH_DAEMON === "1") {
      fail("No credentials found for daemon server.");
    }
    print(`No credentials found. Starting login…\n`);
    await login({ store, onMessage: print });
  } else {
    await store.getSession();
  }

  let running;
  try {
    running = await startAgyOAuthServer({
      host: opts.host,
      port: opts.port,
      auth: store,
      models: opts.models,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("EADDRINUSE")) {
      fail(
        `Port ${opts.host}:${opts.port} is already in use (EADDRINUSE).\n` +
          `  agy-oauth status\n  agy-oauth stop\n  Or pick another port: --port <n>`,
      );
    }
    throw err;
  }

  print("");
  print(`Gemini OAuth proxy ready at ${running.url}`);
  print(`  host: ${running.host}`);
  print(`  port: ${running.port}`);
  if (!opts.portExplicit && running.port === DEFAULT_PORT) {
    print(
      `  (default port ${DEFAULT_PORT}; override with --port or AGY_OAUTH_PORT)`,
    );
  }
  print(`Use this as your OpenAI base URL. No API key is required.`);
  print(
    `Available models: ${running.models.length ? running.models.join(", ") : "(none)"}`,
  );
  print("");
  print(`Examples:`);
  print(`  curl ${running.url}/models`);
  print(
    `  curl ${running.url}/chat/completions -H 'Content-Type: application/json' -d '{"model":"gemini-2.5-flash","messages":[{"role":"user","content":"hi"}]}'`,
  );
  if (process.env.AGY_OAUTH_DAEMON === "1") {
    print(`(detached daemon mode — stop with: agy-oauth stop)`);
  } else {
    print("");
    print(`Press Ctrl+C to stop.`);
  }

  const shutdown = async () => {
    print("\nShutting down…");
    await running.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await new Promise<void>(() => {
    // keep alive until signal
  });
}

async function cmdLogs(follow: boolean): Promise<void> {
  const daemon = getRunningDaemon();
  const logFile = daemon?.logFile ?? DAEMON_LOG_FILE;
  if (!existsSync(logFile)) {
    fail(`No log file at ${logFile}`);
  }

  if (!follow) {
    process.stdout.write(readFileSync(logFile, "utf8"));
    return;
  }

  const { spawn } = await import("node:child_process");
  const child = spawn("tail", ["-n", "50", "-f", logFile], {
    stdio: "inherit",
  });
  const stop = () => {
    child.kill("SIGTERM");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      host: { type: "string" },
      port: { type: "string" },
      "auth-file": { type: "string" },
      models: { type: "string" },
      project: { type: "string" },
      open: { type: "boolean", default: true },
      "no-open": { type: "boolean", default: false },
      device: { type: "boolean", default: false },
      "timeout-ms": { type: "string" },
      detach: { type: "boolean", short: "d", default: false },
      foreground: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      follow: { type: "boolean", short: "f", default: false },
      help: { type: "boolean", default: false },
      version: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    print(help);
    return;
  }
  if (values.version) {
    print(`${PACKAGE_NAME} ${PACKAGE_VERSION}`);
    return;
  }

  const command = (positionals[0] ?? "serve").toLowerCase();
  const authFile = values["auth-file"] ?? DEFAULT_AUTH_FILE;
  const open = values["no-open"] ? false : values.open !== false;
  const project = values.project;

  if (command === "help") {
    print(help);
    return;
  }

  if (command === "login") {
    await cmdLogin({
      authFile,
      open,
      device: Boolean(values.device),
      timeoutMs: values["timeout-ms"]
        ? Number(values["timeout-ms"])
        : undefined,
      project,
    });
    return;
  }

  if (command === "logout") {
    const store = new GeminiAuthStore({ authFilePath: authFile });
    store.clear();
    print(`Cleared credentials at ${authFile}`);
    return;
  }

  if (command === "status") {
    await cmdAuthStatus(authFile, project);
    return;
  }

  if (command === "stop") {
    const stopped = await stopDaemon();
    if (!stopped) {
      print("No detached server is running.");
      return;
    }
    print(`Stopped server pid ${stopped.pid} (${stopped.url})`);
    return;
  }

  if (command === "logs") {
    await cmdLogs(Boolean(values.follow));
    return;
  }

  if (command === "serve" || command === "start" || command === "proxy") {
    const portExplicit = Boolean(values.port || process.env.AGY_OAUTH_PORT);
    const port = values.port ? Number(values.port) : resolveDefaultPort();
    if (!Number.isFinite(port) || port <= 0) {
      fail(`Invalid --port: ${values.port ?? process.env.AGY_OAUTH_PORT}`);
    }
    const host = values.host ?? DEFAULT_HOST;

    const rawServeArgs: string[] = [];
    if (values.host) rawServeArgs.push("--host", values.host);
    rawServeArgs.push("--port", String(port));
    if (values["auth-file"])
      rawServeArgs.push("--auth-file", values["auth-file"]);
    if (values.models) rawServeArgs.push("--models", values.models);
    if (values.project) rawServeArgs.push("--project", values.project);

    await cmdServe({
      host,
      port,
      authFile,
      models: values.models
        ? values.models
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
      project,
      detach: Boolean(values.detach),
      foreground: Boolean(values.foreground),
      force: Boolean(values.force),
      portExplicit,
      rawServeArgs,
    });
    return;
  }

  fail(`Unknown command: ${command}\n\n${help}`);
}

main().catch((err) => {
  fail(err instanceof Error ? err.stack ?? err.message : String(err));
});
