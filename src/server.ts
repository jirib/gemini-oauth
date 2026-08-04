import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  PACKAGE_NAME,
  PACKAGE_VERSION,
} from "./constants.js";
import type { GeminiAuthStore } from "./auth.js";
import type { OpenAIChatRequest } from "./convert.js";
import { GeminiUpstream } from "./upstream.js";

export type ServerOptions = {
  host?: string;
  port?: number;
  auth: GeminiAuthStore;
  models?: string[];
};

export type RunningServer = {
  host: string;
  port: number;
  url: string;
  models: string[];
  close: () => Promise<void>;
};

const readBody = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

const sendJson = (
  res: ServerResponse,
  status: number,
  body: unknown,
): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
};

const pipeStream = async (
  stream: ReadableStream<Uint8Array>,
  res: ServerResponse,
): Promise<void> => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    res.destroy(err instanceof Error ? err : undefined);
  }
};

export async function startAgyOAuthServer(
  options: ServerOptions,
): Promise<RunningServer> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const upstream = new GeminiUpstream({
    auth: options.auth,
    models: options.models,
  });

  // Ensure project is resolvable at startup so first request is faster.
  try {
    await options.auth.ensureProjectId();
  } catch (err) {
    console.warn(
      `[${PACKAGE_NAME}] project resolution deferred:`,
      err instanceof Error ? err.message : err,
    );
  }

  let models = options.models ?? (await upstream.listModels());

  const server = createServer(async (req, res) => {
    try {
      const hostHeader = req.headers.host ?? `${host}:${port}`;
      const url = new URL(req.url ?? "/", `http://${hostHeader}`);
      const path = url.pathname;

      if (req.method === "GET" && (path === "/" || path === "/health")) {
        const session = options.auth.getSessionSnapshot();
        sendJson(res, 200, {
          ok: true,
          name: PACKAGE_NAME,
          version: PACKAGE_VERSION,
          upstream: "cloudcode-pa.googleapis.com",
          project_id: session?.projectId ?? null,
          replay_state: "stateless",
        });
        return;
      }

      if (req.method === "GET" && path === "/v1/models") {
        models = await upstream.listModels();
        sendJson(res, 200, {
          object: "list",
          data: models.map((id) => ({
            id,
            object: "model",
            created: 0,
            owned_by: "google-oauth",
          })),
        });
        return;
      }

      if (req.method === "POST" && path === "/v1/chat/completions") {
        const bodyBuf = await readBody(req);
        let parsed: OpenAIChatRequest;
        try {
          parsed = JSON.parse(bodyBuf.toString("utf8")) as OpenAIChatRequest;
        } catch {
          sendJson(res, 400, {
            error: {
              message: "Invalid JSON body",
              type: "invalid_request_error",
            },
          });
          return;
        }
        if (!parsed.model || !Array.isArray(parsed.messages)) {
          sendJson(res, 400, {
            error: {
              message: "Request must include model and messages",
              type: "invalid_request_error",
            },
          });
          return;
        }

        const result = await upstream.chatCompletions(parsed);
        if (result.kind === "stream") {
          await pipeStream(result.stream, res);
          return;
        }
        sendJson(res, result.status, result.body);
        return;
      }

      if (req.method === "POST" && path === "/v1/responses") {
        const bodyBuf = await readBody(req);
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(bodyBuf.toString("utf8")) as Record<
            string,
            unknown
          >;
        } catch {
          sendJson(res, 400, {
            error: {
              message: "Invalid JSON body",
              type: "invalid_request_error",
            },
          });
          return;
        }
        const result = await upstream.responses(parsed);
        if (result.kind === "stream") {
          await pipeStream(result.stream, res);
          return;
        }
        sendJson(res, result.status, result.body);
        return;
      }

      sendJson(res, 404, {
        error: {
          message: `Route not found: ${req.method} ${path}`,
          type: "not_found_error",
        },
      });
    } catch (err) {
      if (res.headersSent) {
        res.destroy(err instanceof Error ? err : undefined);
        return;
      }
      sendJson(res, 500, {
        error: {
          message:
            err instanceof Error ? err.message : "Unexpected server error",
          type: "server_error",
        },
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo;
  const boundHost = addr.address === "::" ? host : addr.address;
  const boundPort = addr.port;

  return {
    host: boundHost,
    port: boundPort,
    url: `http://${boundHost}:${boundPort}/v1`,
    models,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
