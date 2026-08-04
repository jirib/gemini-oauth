#!/usr/bin/env python3
import os
from openai import OpenAI

client = OpenAI(
    api_key="agy-oauth",
    base_url=os.environ.get("AGY_OAUTH_BASE", "http://127.0.0.1:10551/v1"),
)

r = client.chat.completions.create(
    model=os.environ.get("AGY_OAUTH_MODEL", "gemini-2.5-flash"),
    messages=[{"role": "user", "content": "Reply with exactly: PY_OK"}],
)
print(r.choices[0].message.content)
