import assert from "node:assert/strict";
import test from "node:test";
import { loginBrowser } from "../dist/oauth-login.js";

const waitFor = async (read, timeoutMs = 1000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for login URL");
};

const startLogin = ({ fetch, timeoutMs = 1000, store = {} } = {}) => {
  let authUrl;
  const promise = loginBrowser({
    store,
    fetch: fetch ?? globalThis.fetch,
    open: false,
    timeoutMs,
    onMessage(message) {
      const match = message.match(/https:\/\/[^\s]+/);
      if (match) authUrl = new URL(match[0]);
    },
  });
  return { promise, getAuthUrl: () => authUrl };
};

test("OAuth errors reject immediately and escape callback HTML", async () => {
  const login = startLogin({ timeoutMs: 2000 });
  const rejected = assert.rejects(login.promise, /OAuth error: access_denied/);
  const authUrl = await waitFor(login.getAuthUrl);
  const callback = new URL(authUrl.searchParams.get("redirect_uri"));
  callback.searchParams.set("state", authUrl.searchParams.get("state"));
  callback.searchParams.set("error", "access_denied");
  callback.searchParams.set("error_description", "<script>alert(1)</script>");

  const response = await fetch(callback);
  const html = await response.text();
  assert.equal(response.status, 400);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  await rejected;
});

test("wrong OAuth state is not reported as a successful callback", async () => {
  const login = startLogin({ timeoutMs: 150 });
  const rejected = assert.rejects(login.promise, /Login timed out/);
  const authUrl = await waitFor(login.getAuthUrl);
  const callback = new URL(authUrl.searchParams.get("redirect_uri"));
  callback.searchParams.set("state", "wrong-state");
  callback.searchParams.set("code", "code");

  const response = await fetch(callback);
  const html = await response.text();
  assert.equal(response.status, 400);
  assert.doesNotMatch(html, /<h1>Signed in<\/h1>/);
  await rejected;
});

test("token exchange requires a non-empty access_token", async () => {
  let saved = false;
  const store = {
    saveOAuthTokens() {
      saved = true;
    },
  };
  const login = startLogin({
    store,
    fetch: async () =>
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  const rejected = assert.rejects(login.promise, /missing access_token/);
  const authUrl = await waitFor(login.getAuthUrl);
  const callback = new URL(authUrl.searchParams.get("redirect_uri"));
  callback.searchParams.set("state", authUrl.searchParams.get("state"));
  callback.searchParams.set("code", "code");
  const response = await fetch(callback);
  assert.equal(response.status, 200);
  await rejected;
  assert.equal(saved, false);
});
