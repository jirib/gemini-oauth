import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { exec } from "node:child_process";
import { platform } from "node:os";
import type { AddressInfo } from "node:net";
import {
  GOOGLE_AUTH_URL,
  GOOGLE_TOKEN_URL,
  GOOGLE_USERINFO_URL,
  OAUTH_CLIENT_ID,
  OAUTH_CLIENT_SECRET,
  OAUTH_SCOPES,
  userAgent,
} from "./constants.js";
import type { GeminiAuthStore } from "./auth.js";

const base64Url = (buf: Buffer): string =>
  buf
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");

const randomString = (bytes = 32): string => base64Url(randomBytes(bytes));

const sha256Base64Url = (value: string): string =>
  base64Url(createHash("sha256").update(value).digest());

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });

const openBrowser = (url: string): void => {
  const cmd =
    platform() === "darwin"
      ? `open ${JSON.stringify(url)}`
      : platform() === "win32"
        ? `start "" ${JSON.stringify(url)}`
        : `xdg-open ${JSON.stringify(url)}`;
  exec(cmd, () => {
    // ignore open failures; user can paste the URL
  });
};

export type LoginOptions = {
  store: GeminiAuthStore;
  open?: boolean;
  timeoutMs?: number;
  host?: string;
  /** Headless: print auth URL and wait for pasted authorization code. */
  device?: boolean;
  fetch?: typeof fetch;
  onMessage?: (message: string) => void;
};

export type LoginResult = {
  email?: string;
  projectId?: string;
};

const exchangeCode = async (
  fetchImpl: typeof fetch,
  params: {
    code: string;
    codeVerifier?: string;
    redirectUri: string;
    clientId: string;
    clientSecret: string;
  },
): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  scope?: string;
  token_type?: string;
}> => {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    client_secret: params.clientSecret,
  });
  if (params.codeVerifier) {
    body.set("code_verifier", params.codeVerifier);
  }

  const response = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": userAgent(),
    },
    body,
    redirect: "error",
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Code exchange failed (${response.status}): ${text.slice(0, 500)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Code exchange returned non-JSON body");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).access_token !== "string" ||
    !(parsed as Record<string, unknown>).access_token
  ) {
    throw new Error("Code exchange response missing access_token");
  }
  return parsed as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    id_token?: string;
    scope?: string;
    token_type?: string;
  };
};

const fetchUserEmail = async (
  fetchImpl: typeof fetch,
  accessToken: string,
): Promise<string | undefined> => {
  try {
    const response = await fetchImpl(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      redirect: "error",
    });
    if (!response.ok) return undefined;
    const info = (await response.json()) as { email?: string };
    return typeof info.email === "string" ? info.email : undefined;
  } catch {
    return undefined;
  }
};

const persistTokens = async (
  store: GeminiAuthStore,
  tokens: {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    id_token?: string;
    scope?: string;
    token_type?: string;
  },
  fetchImpl: typeof fetch,
  log: (m: string) => void,
): Promise<LoginResult> => {
  const email = await fetchUserEmail(fetchImpl, tokens.access_token);
  store.saveOAuthTokens({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in,
    scope: tokens.scope,
    idToken: tokens.id_token,
    tokenType: tokens.token_type,
    email,
  });

  let projectId: string | undefined;
  try {
    projectId = await store.ensureProjectId({ force: true });
    log(`Project resolved: ${projectId}`);
  } catch (err) {
    log(
      `Warning: project resolution failed — ${err instanceof Error ? err.message : String(err)}`,
    );
    log(
      "You can set GOOGLE_CLOUD_PROJECT and re-run, or start the server after fixing access.",
    );
  }

  log(`Login successful. Credentials saved to ${store.authFilePath}`);
  return { email, projectId };
};

/**
 * Browser loopback OAuth (same as Gemini CLI `authWithWeb`).
 * Callback: http://127.0.0.1:<port>/oauth2callback
 */
export async function loginBrowser(options: LoginOptions): Promise<LoginResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const log = options.onMessage ?? console.log;
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const host = options.host ?? "127.0.0.1";
  const clientId = OAUTH_CLIENT_ID;
  const clientSecret = OAUTH_CLIENT_SECRET;

  const state = randomString(16);
  const codeVerifier = randomString(32);
  const codeChallenge = sha256Base64Url(codeVerifier);

  let resolveCode!: (value: { code: string; state: string }) => void;
  let rejectCode!: (error: Error) => void;
  const waitForCode = new Promise<{ code: string; state: string }>(
    (resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    },
  );
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/oauth2callback" && url.pathname !== "/callback") {
        res.writeHead(404).end("Not found");
        return;
      }
      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (returnedState !== state) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          "<html><body><h1>Login failed</h1><p>OAuth state mismatch. Return to the terminal and retry.</p></body></html>",
        );
        return;
      }

      if (error) {
        const description =
          url.searchParams.get("error_description") ?? error;
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          `<html><body><h1>Login failed</h1><p>${escapeHtml(description)}</p><p>You can close this window.</p></body></html>`,
        );
        if (!settled) {
          settled = true;
          if (timer) clearTimeout(timer);
          server.close();
          rejectCode(new Error(`OAuth error: ${error}`));
        }
        return;
      }

      if (!code) {
        res.writeHead(400).end("Missing authorization code");
        if (!settled) {
          settled = true;
          if (timer) clearTimeout(timer);
          server.close();
          rejectCode(new Error("OAuth callback missing authorization code"));
        }
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<html><body><h1>Signed in</h1><p>You can close this window and return to the terminal.</p></body></html>",
      );
      if (!settled) {
        settled = true;
        if (timer) clearTimeout(timer);
        server.close();
        resolveCode({ code, state: returnedState });
      }
    } catch (error) {
      if (!res.headersSent) res.writeHead(500).end("OAuth callback failed");
      if (!settled) {
        settled = true;
        if (timer) clearTimeout(timer);
        server.close();
        rejectCode(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onStartupError = (error: Error) => reject(error);
    server.once("error", onStartupError);
    server.listen(0, host, () => {
      server.off("error", onStartupError);
      resolve();
    });
  });
  server.once("error", (error) => {
    if (!settled) {
      settled = true;
      if (timer) clearTimeout(timer);
      rejectCode(error);
    }
  });

  const addr = server.address() as AddressInfo;
  const callbackAddress =
    addr.address === "0.0.0.0"
      ? "127.0.0.1"
      : addr.address === "::"
        ? "::1"
        : addr.address;
  const callbackHost = callbackAddress.includes(":")
    ? `[${callbackAddress}]`
    : callbackAddress;
  // Google desktop OAuth requires a loopback IP literal.
  const redirectUri = `http://${callbackHost}:${addr.port}/oauth2callback`;
  timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    server.close();
    rejectCode(new Error(`Login timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  const authUrl = new URL(GOOGLE_AUTH_URL);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", OAUTH_SCOPES.join(" "));
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");

  log(`Open this URL to sign in:\n${authUrl.toString()}\n`);
  if (options.open !== false) {
    openBrowser(authUrl.toString());
  }

  const result = await waitForCode;

  const tokens = await exchangeCode(fetchImpl, {
    code: result.code,
    codeVerifier,
    redirectUri,
    clientId,
    clientSecret,
  });

  return persistTokens(options.store, tokens, fetchImpl, log);
}

/**
 * Headless / SSH login: print URL that uses codeassist.google.com redirect,
 * then paste the authorization code (same as Gemini CLI `authWithUserCode`).
 */
export async function loginDevice(options: LoginOptions): Promise<LoginResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const log = options.onMessage ?? console.log;
  const clientId = OAUTH_CLIENT_ID;
  const clientSecret = OAUTH_CLIENT_SECRET;
  const redirectUri = "https://codeassist.google.com/authcode";

  const state = randomString(16);
  const codeVerifier = randomString(32);
  const codeChallenge = sha256Base64Url(codeVerifier);

  const authUrl = new URL(GOOGLE_AUTH_URL);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", OAUTH_SCOPES.join(" "));
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");

  log(`Device / headless login`);
  log(`  Visit: ${authUrl.toString()}`);
  log(`  Then paste the authorization code below.\n`);
  if (options.open !== false) {
    openBrowser(authUrl.toString());
  }

  const { createInterface } = await import("node:readline");
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  const code = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => {
        rl.close();
        reject(new Error("Login timed out waiting for authorization code"));
      },
      options.timeoutMs ?? 5 * 60 * 1000,
    );
    rl.question("Authorization code: ", (answer) => {
      clearTimeout(timer);
      rl.close();
      resolve(answer.trim());
    });
  });

  if (!code) {
    throw new Error("Authorization code is required");
  }

  const tokens = await exchangeCode(fetchImpl, {
    code,
    codeVerifier,
    redirectUri,
    clientId,
    clientSecret,
  });

  return persistTokens(options.store, tokens, fetchImpl, log);
}

export async function login(options: LoginOptions): Promise<LoginResult> {
  if (options.device) {
    return loginDevice(options);
  }
  return loginBrowser(options);
}
