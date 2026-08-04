import assert from "node:assert/strict";
import test from "node:test";
import {
  GeminiUpstream,
  createOpenAIStreamFromGemini,
} from "../dist/upstream.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const readAll = async (stream) => {
  const reader = stream.getReader();
  let result = "";
  for (;;) {
    const next = await reader.read();
    if (next.done) return result;
    result += decoder.decode(next.value, { stream: true });
  }
};

test("SSE conversion accepts fragmented multi-line data events", async () => {
  const payload = JSON.stringify(
    {
      response: {
        candidates: [
          {
            content: { role: "model", parts: [{ text: "hello" }] },
            finishReason: "STOP",
          },
        ],
      },
    },
    null,
    2,
  );
  const event = `${payload
    .split("\n")
    .map((line) => `data: ${line}`)
    .join("\n")}\n\n`;
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(event.slice(0, 17)));
      controller.enqueue(encoder.encode(event.slice(17)));
      controller.close();
    },
  });

  const output = await readAll(createOpenAIStreamFromGemini(source, "model"));
  assert.match(output, /"object":"chat\.completion\.chunk"/);
  assert.match(output, /"content":"hello"/);
  assert.ok(output.endsWith("data: [DONE]\n\n"));
});

test("downstream cancellation is propagated to the upstream SSE reader", async () => {
  let canceled = false;
  const source = new ReadableStream({
    pull() {
      // Keep the stream open until the downstream consumer cancels.
    },
    cancel() {
      canceled = true;
    },
  });
  const converted = createOpenAIStreamFromGemini(source, "model");
  await converted.getReader().cancel("test complete");
  assert.equal(canceled, true);
});

test("malformed SSE JSON fails instead of silently returning DONE", async () => {
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("data: {not-json}\n\n"));
      controller.close();
    },
  });
  await assert.rejects(
    readAll(createOpenAIStreamFromGemini(source, "model")),
    /Malformed JSON/,
  );
});

test("Responses streaming is rejected with a protocol-specific error", async () => {
  const upstream = new GeminiUpstream({ auth: {} });
  const result = await upstream.responses({
    model: "model",
    input: "hello",
    stream: true,
  });
  assert.equal(result.kind, "error");
  assert.equal(result.status, 400);
  assert.equal(result.body.error.type, "unsupported_parameter");
});
