import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCodeAssistBody,
  chatCompletionToResponses,
  geminiChunkToOpenAI,
  geminiResponseToOpenAI,
} from "../dist/convert.js";

test("tool results reuse the function name referenced by tool_call_id", () => {
  const body = buildCodeAssistBody(
    {
      model: "gemini-test",
      messages: [
        { role: "user", content: "weather" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_weather",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Seoul"}' },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_weather",
          content: '{"temperature":28}',
        },
      ],
    },
    "project-test",
  );

  const contents = body.request.contents;
  assert.ok(Array.isArray(contents));
  assert.equal(
    contents[2].parts[0].functionResponse.name,
    "get_weather",
  );
});

test("Responses conversion marks truncated completions as incomplete", () => {
  const response = chatCompletionToResponses(
    {
      choices: [
        { message: { content: "partial" }, finish_reason: "length" },
      ],
      usage: {},
    },
    "gemini-test",
  );
  assert.equal(response.status, "incomplete");
  assert.equal(response.incomplete_details.reason, "max_output_tokens");
  assert.equal(response.output[0].status, "incomplete");
});

test("Gemini responses preserve text alongside tool calls", () => {
  const response = geminiResponseToOpenAI(
    {
      candidates: [
        {
          finishReason: "STOP",
          content: {
            role: "model",
            parts: [
              { text: "I will check. " },
              { functionCall: { name: "lookup", args: { id: 7 } } },
            ],
          },
        },
      ],
    },
    "gemini-test",
  );

  const choice = response.choices[0];
  assert.equal(choice.message.content, "I will check. ");
  assert.equal(choice.message.tool_calls[0].function.name, "lookup");
  assert.equal(choice.finish_reason, "tool_calls");
});

test("streaming tool call ids are stable and role is only sent once", () => {
  const state = {
    toolCallIds: new Map(),
    sawToolCalls: false,
    sentRole: false,
  };
  const chunkBody = {
    candidates: [
      {
        finishReason: "STOP",
        content: {
          role: "model",
          parts: [{ functionCall: { name: "lookup", args: { id: 7 } } }],
        },
      },
    ],
  };

  const first = geminiChunkToOpenAI(chunkBody, "gemini-test", "chunk", state);
  const second = geminiChunkToOpenAI(chunkBody, "gemini-test", "chunk", state);
  const firstChoice = first.choices[0];
  const secondChoice = second.choices[0];

  assert.equal(firstChoice.delta.role, "assistant");
  assert.equal("role" in secondChoice.delta, false);
  assert.equal(
    firstChoice.delta.tool_calls[0].id,
    secondChoice.delta.tool_calls[0].id,
  );
  assert.equal(secondChoice.finish_reason, "tool_calls");
});
