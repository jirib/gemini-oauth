import { randomUUID } from "node:crypto";
import {
  CODE_ASSIST_HEADERS,
  DEFAULT_MODELS,
  clientMetadata,
  methodUrl,
  antigravityUserAgent,
} from "./constants.js";
import type { GeminiAuthStore } from "./auth.js";
import {
  buildCodeAssistBody,
  chatCompletionToResponses,
  geminiChunkToOpenAI,
  geminiResponseToOpenAI,
  responsesRequestToChat,
  type GeminiResponse,
  type OpenAIChatRequest,
} from "./convert.js";

export type UpstreamOptions = {
  auth: GeminiAuthStore;
  models?: string[];
  fetch?: typeof fetch;
};

export class GeminiUpstream {
  private readonly auth: GeminiAuthStore;
  private readonly fetchImpl: typeof fetch;
  private models: string[];

  constructor(options: UpstreamOptions) {
    this.auth = options.auth;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.models = options.models?.length
      ? options.models
      : [...DEFAULT_MODELS];
  }

  listModelsCached(): string[] {
    return [...this.models];
  }

  async listModels(): Promise<string[]> {
    // Code Assist has no public models list; return configured allowlist.
    return this.listModelsCached();
  }

  private async authHeaders(
    model: string,
    streaming: boolean,
  ): Promise<Record<string, string>> {
    const token = await this.auth.getAccessToken();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": antigravityUserAgent(),
      "x-activity-request-id": randomUUID(),
      "X-Goog-Api-Client": CODE_ASSIST_HEADERS["X-Goog-Api-Client"],
      "Client-Metadata": clientMetadata("ANTIGRAVITY"),
    };
    if (streaming) {
      headers.Accept = "text/event-stream";
    } else {
      headers.Accept = "application/json";
    }
    return headers;
  }

  private async doFetch(
    url: string,
    headers: Record<string, string>,
    body: string,
  ): Promise<Response> {
    const run = async (forceRefresh = false): Promise<Response> => {
      if (forceRefresh) {
        await this.auth.getAccessToken({ forceRefresh: true });
        headers.Authorization = `Bearer ${await this.auth.getAccessToken()}`;
      }
      return this.fetchImpl(url, {
        method: "POST",
        headers,
        body,
        redirect: "error",
      });
    };

    let response = await run(false);
    if (response.status === 401) {
      response = await run(true);
    }
    return response;
  }

  async chatCompletions(
    openAiRequest: OpenAIChatRequest,
  ): Promise<
    | { kind: "json"; status: number; body: unknown }
    | { kind: "stream"; status: number; stream: ReadableStream<Uint8Array> }
    | { kind: "error"; status: number; body: unknown }
  > {
    const projectId = await this.auth.ensureProjectId();
    const streaming = openAiRequest.stream === true;
    const model = openAiRequest.model || "gemini-2.5-flash";
    const url = methodUrl(
      streaming ? "streamGenerateContent" : "generateContent",
      streaming,
    );
    const envelope = buildCodeAssistBody(
      { ...openAiRequest, model },
      projectId,
    );
    const headers = await this.authHeaders(model, streaming);
    const response = await this.doFetch(
      url,
      headers,
      JSON.stringify(envelope),
    );

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      return {
        kind: "error",
        status: response.status,
        body: {
          error: {
            message: `Upstream error (${response.status}): ${errText.slice(0, 800)}`,
            type: "api_error",
            code: String(response.status),
          },
        },
      };
    }

    if (streaming && response.body) {
      return {
        kind: "stream",
        status: response.status,
        stream: createOpenAIStreamFromGemini(response.body, model),
      };
    }

    const geminiJson = (await response.json()) as Record<string, unknown>;
    const inner = (geminiJson.response ?? geminiJson) as GeminiResponse;
    return {
      kind: "json",
      status: 200,
      body: geminiResponseToOpenAI(inner, model),
    };
  }

  async responses(
    body: Record<string, unknown>,
  ): Promise<
    | { kind: "json"; status: number; body: unknown }
    | { kind: "stream"; status: number; stream: ReadableStream<Uint8Array> }
    | { kind: "error"; status: number; body: unknown }
  > {
    const chatReq = responsesRequestToChat(body);
    if (chatReq.stream) {
      // Stream as OpenAI chat chunks is fine for many clients; full Responses
      // SSE event protocol is not implemented.
      return this.chatCompletions(chatReq);
    }
    const result = await this.chatCompletions(chatReq);
    if (result.kind !== "json") return result;
    return {
      kind: "json",
      status: 200,
      body: chatCompletionToResponses(
        result.body as Record<string, unknown>,
        chatReq.model,
      ),
    };
  }
}

export function createOpenAIStreamFromGemini(
  geminiStream: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const chunkId = `chatcmpl-${randomUUID()}`;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const reader = geminiStream.getReader();

      const pump = (): void => {
        reader
          .read()
          .then(({ done, value }) => {
            if (done) {
              if (buffer.trim()) {
                processSseLine(
                  buffer.trim(),
                  chunkId,
                  model,
                  controller,
                  encoder,
                );
              }
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
              return;
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (trimmed) {
                processSseLine(trimmed, chunkId, model, controller, encoder);
              }
            }
            pump();
          })
          .catch((error) => {
            controller.error(error);
          });
      };

      pump();
    },
  });
}

function processSseLine(
  line: string,
  chunkId: string,
  model: string,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
): void {
  if (!line.startsWith("data:")) return;
  const json = line.slice(5).trim();
  if (!json || json === "[DONE]") return;

  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const geminiBody = (parsed.response ?? parsed) as GeminiResponse;
    const chunk = geminiChunkToOpenAI(geminiBody, model, chunkId);
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
  } catch {
    // skip malformed chunks
  }
}
