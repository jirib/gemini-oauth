import { randomUUID } from "node:crypto";

/* ── OpenAI request / response shapes (subset) ─────────────────────── */

export type OpenAIMessage = {
  role: "system" | "user" | "assistant" | "tool" | string;
  content?:
    | string
    | null
    | Array<{
        type: string;
        text?: string;
        image_url?: { url: string };
      }>;
  name?: string;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
};

export type OpenAIToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type OpenAITool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

export type OpenAIChatRequest = {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  top_p?: number;
  tools?: OpenAITool[];
  tool_choice?: unknown;
  stop?: string | string[];
  [key: string]: unknown;
};

export type GeminiPart = {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
  thought?: boolean;
  [key: string]: unknown;
};

export type GeminiContent = {
  role: "user" | "model";
  parts: GeminiPart[];
};

export type GeminiCandidate = {
  content?: GeminiContent;
  finishReason?: string;
  index?: number;
};

export type GeminiUsageMetadata = {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
};

export type GeminiResponse = {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
  [key: string]: unknown;
};

export type GeminiRequestEnvelope = {
  project: string;
  model: string;
  user_prompt_id: string;
  request: Record<string, unknown>;
};

/* ── OpenAI → Code Assist ──────────────────────────────────────────── */

export function buildCodeAssistBody(
  openAiRequest: OpenAIChatRequest,
  projectId: string,
): GeminiRequestEnvelope {
  const { contents, systemInstruction } = convertMessages(
    openAiRequest.messages,
  );
  const tools = openAiRequest.tools
    ? convertTools(openAiRequest.tools)
    : undefined;

  const requestPayload: Record<string, unknown> = { contents };

  if (systemInstruction) {
    requestPayload.systemInstruction = systemInstruction;
  }
  if (tools) {
    requestPayload.tools = tools;
  }

  const generationConfig: Record<string, unknown> = {};
  if (openAiRequest.temperature !== undefined) {
    generationConfig.temperature = openAiRequest.temperature;
  }
  const maxTokens =
    openAiRequest.max_tokens ?? openAiRequest.max_completion_tokens;
  if (maxTokens !== undefined) {
    generationConfig.maxOutputTokens = maxTokens;
  }
  if (openAiRequest.top_p !== undefined) {
    generationConfig.topP = openAiRequest.top_p;
  }
  if (openAiRequest.stop !== undefined) {
    generationConfig.stopSequences = Array.isArray(openAiRequest.stop)
      ? openAiRequest.stop
      : [openAiRequest.stop];
  }
  const requestedEffort =
    typeof openAiRequest.reasoning_effort === "string"
      ? openAiRequest.reasoning_effort
      : undefined;
  const modelEffort = openAiRequest.model.match(/-(high|medium|low)$/)?.[1];
  const effort = requestedEffort ?? modelEffort;
  const thinkingBudget =
    effort === "high" ? 10_000 : effort === "medium" ? 4_000 : effort === "low" ? 1_000 : undefined;
  if (thinkingBudget !== undefined) {
    generationConfig.thinkingConfig = {
      thinkingBudget,
      includeThoughts: true,
    };
  }
  if (Object.keys(generationConfig).length > 0) {
    requestPayload.generationConfig = generationConfig;
  }

  return {
    project: projectId,
    model: openAiRequest.model,
    user_prompt_id: randomUUID(),
    request: requestPayload,
  };
}

function convertMessages(messages: OpenAIMessage[]): {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiPart[] };
} {
  const contents: GeminiContent[] = [];
  let systemInstruction: { parts: GeminiPart[] } | undefined;

  for (const message of messages) {
    if (message.role === "system") {
      const text =
        typeof message.content === "string"
          ? message.content
          : extractTextContent(message.content);
      if (text) {
        if (!systemInstruction) {
          systemInstruction = { parts: [{ text }] };
        } else {
          systemInstruction.parts.push({ text });
        }
      }
      continue;
    }

    if (message.role === "tool") {
      const part: GeminiPart = {
        functionResponse: {
          name: message.name ?? "tool",
          response: {
            content:
              typeof message.content === "string"
                ? message.content
                : extractTextContent(message.content),
          },
        },
      };
      const last = contents[contents.length - 1];
      if (last && last.role === "user") {
        last.parts.push(part);
      } else {
        contents.push({ role: "user", parts: [part] });
      }
      continue;
    }

    const role: "user" | "model" =
      message.role === "assistant" ? "model" : "user";
    const parts = messageToGeminiParts(message);
    if (parts.length > 0) {
      contents.push({ role, parts });
    }
  }

  return { contents: mergeConsecutiveTurns(contents), systemInstruction };
}

function messageToGeminiParts(message: OpenAIMessage): GeminiPart[] {
  const parts: GeminiPart[] = [];

  if (message.tool_calls && message.tool_calls.length > 0) {
    for (const tc of message.tool_calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
      } catch {
        args = { _raw: tc.function.arguments };
      }
      parts.push({ functionCall: { name: tc.function.name, args } });
    }
    if (typeof message.content === "string" && message.content) {
      parts.unshift({ text: message.content });
    }
    return parts;
  }

  if (typeof message.content === "string") {
    if (message.content) parts.push({ text: message.content });
    return parts;
  }

  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block.type === "text" && block.text) {
        parts.push({ text: block.text });
      } else if (block.type === "image_url" && block.image_url) {
        const url = block.image_url.url;
        if (url.startsWith("data:")) {
          const [header, data] = url.split(",");
          const mimeType = (header ?? "")
            .replace("data:", "")
            .replace(";base64", "");
          parts.push({ inlineData: { mimeType, data: data ?? "" } });
        }
      }
    }
  }

  return parts;
}

function extractTextContent(content: OpenAIMessage["content"]): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}

function mergeConsecutiveTurns(contents: GeminiContent[]): GeminiContent[] {
  const merged: GeminiContent[] = [];
  for (const turn of contents) {
    const last = merged[merged.length - 1];
    if (last && last.role === turn.role) {
      last.parts.push(...turn.parts);
    } else {
      merged.push({ role: turn.role, parts: [...turn.parts] });
    }
  }
  return merged;
}

function convertTools(tools: OpenAITool[]): unknown {
  const functionDeclarations = tools
    .filter((t) => t.type === "function")
    .map((t) => ({
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    }));
  return [{ functionDeclarations }];
}

/* ── Code Assist → OpenAI ──────────────────────────────────────────── */

export function geminiResponseToOpenAI(
  geminiBody: GeminiResponse,
  model: string,
): Record<string, unknown> {
  const candidate = geminiBody.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];

  const toolCalls = extractToolCalls(candidate);
  const textContent = toolCalls
    ? null
    : parts
        .filter((p) => p.text !== undefined && !p.thought)
        .map((p) => p.text ?? "")
        .join("") || null;

  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: textContent,
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: mapFinishReason(candidate?.finishReason),
      },
    ],
    usage: buildUsage(geminiBody.usageMetadata),
  };
}

export function geminiChunkToOpenAI(
  geminiBody: GeminiResponse,
  model: string,
  chunkId: string,
): Record<string, unknown> {
  const candidate = geminiBody.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];

  const toolCallDeltas = extractStreamingToolCalls(candidate);
  const textDelta = toolCallDeltas
    ? undefined
    : parts
        .filter((p) => p.text !== undefined && !p.thought)
        .map((p) => p.text ?? "")
        .join("") || undefined;

  const finishReason = candidate?.finishReason
    ? mapFinishReason(candidate.finishReason)
    : null;

  return {
    id: chunkId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          ...(textDelta !== undefined ? { content: textDelta } : {}),
          ...(toolCallDeltas ? { tool_calls: toolCallDeltas } : {}),
        },
        finish_reason: finishReason,
      },
    ],
  };
}

/**
 * Convert OpenAI Responses API input into chat-style messages, then reuse
 * the same Code Assist path. Minimal support for `input` string or message list.
 */
export function responsesRequestToChat(
  body: Record<string, unknown>,
): OpenAIChatRequest {
  const model = String(body.model ?? "gemini-2.5-flash");
  const messages: OpenAIMessage[] = [];

  if (typeof body.instructions === "string" && body.instructions) {
    messages.push({ role: "system", content: body.instructions });
  }

  const input = body.input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === "string") {
        messages.push({ role: "user", content: item });
        continue;
      }
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const role = String(rec.role ?? "user");
      if (typeof rec.content === "string") {
        messages.push({ role, content: rec.content });
      } else if (Array.isArray(rec.content)) {
        const text = rec.content
          .map((c) => {
            if (typeof c === "string") return c;
            if (c && typeof c === "object") {
              const p = c as Record<string, unknown>;
              if (typeof p.text === "string") return p.text;
              if (typeof p.input_text === "string") return p.input_text;
            }
            return "";
          })
          .filter(Boolean)
          .join("\n");
        messages.push({ role, content: text });
      }
    }
  }

  if (messages.length === 0) {
    messages.push({ role: "user", content: "" });
  }

  return {
    model,
    messages,
    stream: body.stream === true,
    temperature:
      typeof body.temperature === "number" ? body.temperature : undefined,
    max_tokens:
      typeof body.max_output_tokens === "number"
        ? body.max_output_tokens
        : undefined,
  };
}

export function chatCompletionToResponses(
  completion: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  const choices = completion.choices as
    | Array<{
        message?: { content?: string | null };
        finish_reason?: string;
      }>
    | undefined;
  const text = choices?.[0]?.message?.content ?? "";
  const usage = (completion.usage ?? {}) as Record<string, number>;
  const id = `resp_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model,
    output: [
      {
        type: "message",
        id: `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text,
          },
        ],
      },
    ],
    output_text: text,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0,
    },
  };
}

function extractToolCalls(
  candidate: GeminiCandidate | undefined,
): OpenAIToolCall[] | undefined {
  if (!candidate?.content?.parts) return undefined;
  const calls = candidate.content.parts
    .filter((p) => p.functionCall !== undefined)
    .map((p) => ({
      id: `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
      type: "function" as const,
      function: {
        name: p.functionCall?.name ?? "",
        arguments: JSON.stringify(p.functionCall?.args ?? {}),
      },
    }));
  return calls.length > 0 ? calls : undefined;
}

function extractStreamingToolCalls(
  candidate: GeminiCandidate | undefined,
): Array<{
  index: number;
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}> | undefined {
  if (!candidate?.content?.parts) return undefined;
  const calls = candidate.content.parts
    .filter((p) => p.functionCall !== undefined)
    .map((p, index) => ({
      index,
      id: `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
      type: "function" as const,
      function: {
        name: p.functionCall?.name ?? "",
        arguments: JSON.stringify(p.functionCall?.args ?? {}),
      },
    }));
  return calls.length > 0 ? calls : undefined;
}

function mapFinishReason(geminiReason: string | undefined): string {
  switch (geminiReason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
      return "content_filter";
    default:
      return "stop";
  }
}

function buildUsage(meta: GeminiUsageMetadata | undefined) {
  return {
    prompt_tokens: meta?.promptTokenCount ?? 0,
    completion_tokens: meta?.candidatesTokenCount ?? 0,
    total_tokens: meta?.totalTokenCount ?? 0,
  };
}
