const base = process.env.GEMINI_OAUTH_BASE ?? "http://127.0.0.1:10551/v1";

const models = await fetch(`${base}/models`).then((r) => r.json());
console.log(
  "models:",
  models.data?.map((m) => m.id).join(", ") ?? models,
);

const chat = await fetch(`${base}/chat/completions`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: process.env.GEMINI_OAUTH_MODEL ?? "gemini-2.5-flash",
    messages: [{ role: "user", content: "Reply with exactly: FETCH_OK" }],
    stream: false,
  }),
}).then((r) => r.json());

console.log("chat:", chat.choices?.[0]?.message?.content ?? chat);
