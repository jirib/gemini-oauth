import OpenAI from "openai";

const baseURL = process.env.GEMINI_OAUTH_BASE ?? "http://127.0.0.1:10551/v1";

const client = new OpenAI({
  apiKey: "gemini-oauth",
  baseURL,
});

const result = await client.chat.completions.create({
  model: process.env.GEMINI_OAUTH_MODEL ?? "gemini-2.5-flash",
  messages: [{ role: "user", content: "Reply with exactly: HELLO_PROXY" }],
});

console.log(result.choices[0]?.message?.content);
