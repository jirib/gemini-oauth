# agy-oauth

**Gemini CLI OAuth → local OpenAI-compatible API**

`openai-oauth` / `grok-oauth`의 **Gemini CLI** 버전입니다. 이미 로그인된 **Gemini CLI** (`~/.gemini/oauth_creds.json`) 세션 또는 macOS Antigravity keyring 세션을 사용해, 로컬에서 **OpenAI-compatible API subset**을 띄웁니다. 별도 `GEMINI_API_KEY` 없이 Google 계정(Code Assist / Gemini CLI 구독 티어)으로 chat·responses를 호출할 수 있습니다.

```txt
$ npm run install:global
$ agy-oauth --detach --port 18080

Gemini OAuth proxy started in background
  url: http://127.0.0.1:18080/v1
```

> **Unofficial.** Google / Gemini과 무관한 커뮤니티 프로젝트입니다. 계정 이용약관·사용 정책을 준수하세요. 자격 증명은 비밀번호처럼 다루고, 토큰을 공유·재판매하지 마세요. Code Assist OAuth를 서드파티 프록시로 재사용하는 행위는 약관 위반으로 계정 제재 위험이 있습니다.

---

## 무엇을 하나요?

| openai-oauth | grok-oauth | **agy-oauth** |
|---|---|---|
| ChatGPT / Codex OAuth (`~/.codex`) | Grok CLI OAuth (`~/.grok/auth.json`) | Gemini CLI OAuth (`~/.gemini/oauth_creds.json`) |
| Upstream: Codex backend | Upstream: `cli-chat-proxy.grok.com` | Upstream: `daily-cloudcode-pa.googleapis.com/v1internal` |
| 로컬 `http://127.0.0.1:10531/v1` | 로컬 `http://127.0.0.1:10541/v1` | 로컬 `http://127.0.0.1:10551/v1` |
| OpenAI-compatible | 동일 | 동일 (OpenAI SDK, curl, 호환 클라이언트) |

Gemini CLI가 쓰는 **Code Assist 비공개 API**에 OAuth bearer를 붙여, OpenAI chat/completions 형식으로 변환·중계합니다.

---

## 사전 요구사항

1. **Node.js 20+**
2. **Gemini CLI 로그인** (권장) 또는 `agy-oauth login`

```bash
# 공식 CLI로 이미 로그인되어 있으면 그대로 사용됩니다
gemini
# credentials: ~/.gemini/oauth_creds.json
```

Google 계정 + Gemini CLI / Code Assist 이용 가능 티어가 필요합니다. 모델·한도는 **계정 구독**에 따릅니다.

선택적으로 `GOOGLE_CLOUD_PROJECT`를 설정하면 해당 GCP 프로젝트를 사용합니다. 없으면 `loadCodeAssist` / `onboardUser`로 관리형 프로젝트를 자동 해석합니다.

---

## 설치 & 실행

### 소스에서 전역 설치 (권장)

```bash
git clone https://github.com/kimws/agy-oauth.git
cd agy-oauth
npm ci
npm run install:global
# 동일: npm run build && npm install -g .
```

아직 npm registry에는 게시하지 않았습니다. 배포용 tarball을 만들고 설치하려면:

```bash
npm ci
npm pack
npm install -g ./agy-oauth-0.1.0.tgz
```

```bash
# 백그라운드 서버 (기본 포트 10551)
agy-oauth --detach

# 포트 지정
agy-oauth --detach --port 18080

# 상태 / 로그 / 중지
agy-oauth status
agy-oauth logs --follow
agy-oauth stop
```

상태 파일·로그: `~/.gemini/oauth-proxy/` (`state.json`, `server.log`).  
프로젝트 캐시: `~/.gemini/agy-oauth.json`.

### 이 저장소에서 (개발 / foreground)

```bash
cd agy-oauth
npm install
npm run build
npm start                          # foreground, port 10551
node dist/cli.js --port 18080
```

### CLI

```bash
agy-oauth                 # foreground 프록시 (미로그인 시 login 유도)
agy-oauth --detach        # 백그라운드 서버
agy-oauth stop
agy-oauth status
agy-oauth logs [--follow]
agy-oauth login           # 브라우저 OAuth (PKCE)
agy-oauth login --device  # 헤드리스 (코드 붙여넣기)
agy-oauth logout          # Gemini CLI 파일만 정리; Antigravity keyring은 별도 관리
agy-oauth --port 18080
agy-oauth --project my-gcp-project
agy-oauth --models gemini-2.5-pro,gemini-2.5-flash
```

| Flag | Default | 설명 |
|------|---------|------|
| `--host` | `127.0.0.1` | bind 주소. loopback 외 바인딩은 인증 없는 프록시를 네트워크에 노출합니다. |
| `--allow-remote` | off | non-loopback `--host` 사용 시 필요한 명시적 위험 승인 |
| `--port` | `10551` | 포트 |
| `--auth-file` | `~/.gemini/oauth_creds.json` | Gemini CLI와 동일한 auth 파일 |
| `--project` | (auto) | Code Assist / GCP project id |
| `--models` | (built-in list) | 콤마 구분 allowlist |
| `--detach` / `-d` | off | 백그라운드(daemon) 실행 |
| `--device` | off | login 시 headless code paste |
| `--no-open` | off | login 시 브라우저 자동 open 안 함 |
| `--follow` / `-f` | off | `logs` 시 tail -f |

---

## 지원 endpoint

| Method | Path | 설명 |
|--------|------|------|
| `GET` | `/health` | 로컬 헬스 |
| `GET` | `/v1/models` | 모델 목록 (allowlist) |
| `POST` | `/v1/chat/completions` | OpenAI chat (stream 지원) |
| `POST` | `/v1/responses` | 간단 Responses 호환 (non-stream) |

토큰은 만료 임박 시 **자동 refresh** 하고, upstream `401` 시 한 번 더 refresh 후 재시도합니다. refresh 결과는 `~/.gemini/oauth_creds.json`에 기록해 **공식 `gemini` CLI와 공유**합니다.

JSON 요청 본문은 기본 10 MiB까지 허용됩니다. `/v1/responses`에서 `stream: true`를 보내면 잘못된 이벤트 형식으로 응답하지 않고 `400 unsupported_parameter`를 반환합니다. 스트리밍은 `/v1/chat/completions`를 사용하세요.

---

## 사용 예시

### curl

```bash
export BASE=http://127.0.0.1:10551/v1

curl -sS "$BASE/models" | jq .

curl -sS "$BASE/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }' | jq .
```

### OpenAI Node SDK

```bash
npm install openai
```

```js
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "agy-oauth", // 로컬 프록시는 키를 검사하지 않음
  baseURL: "http://127.0.0.1:10551/v1",
});

const result = await client.chat.completions.create({
  model: "gemini-2.5-flash",
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(result.choices[0].message.content);
```

### OpenAI Python SDK

```bash
python -m pip install openai
```

```python
from openai import OpenAI

client = OpenAI(
    api_key="agy-oauth",
    base_url="http://127.0.0.1:10551/v1",
)

r = client.chat.completions.create(
    model="gemini-2.5-flash",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(r.choices[0].message.content)
```

---

## 라이브러리로 쓰기

```ts
import { GeminiAuthStore, startAgyOAuthServer, GeminiUpstream } from "agy-oauth";

const auth = new GeminiAuthStore(); // ~/.gemini/oauth_creds.json
const token = await auth.getAccessToken(); // auto-refresh
const projectId = await auth.ensureProjectId();

const server = await startAgyOAuthServer({ auth, port: 10551 });
console.log(server.url);

// 또는 직접 upstream 호출
const upstream = new GeminiUpstream({ auth });
const result = await upstream.chatCompletions({
  model: "gemini-2.5-flash",
  messages: [{ role: "user", content: "hi" }],
});
```

---

## 동작 원리

1. Gemini CLI는 Google OAuth(PKCE)로 로그인하고 access/refresh 토큰을 `~/.gemini/oauth_creds.json`에 저장합니다.
2. 모델 추론은 공개 Gemini API 키가 아니라 **`https://daily-cloudcode-pa.googleapis.com/v1internal`** (Code Assist private API)를 사용합니다.
3. `agy-oauth`는 그 토큰을 읽어:
   - `Authorization: Bearer …`
   - Antigravity-compatible User-Agent / Client-Metadata
   를 붙이고, OpenAI messages → Gemini `contents` 로 변환한 뒤 `:generateContent` / `:streamGenerateContent` 를 호출합니다.
4. 응답은 다시 OpenAI `chat.completion` (또는 간단 `response`) 형식으로 변환합니다.
5. 프로젝트 ID는 `loadCodeAssist` / `onboardUser`로 해석해 `~/.gemini/agy-oauth.json`에 캐시합니다.

---

## 제한 사항

- 계정에 허용된 **CLI / Code Assist 모델**만 동작합니다. API 키 전용 모델은 없을 수 있습니다.
- 프록시는 **stateless**입니다. 대화 히스토리는 클라이언트가 매 요청에 넣어야 합니다.
- `/v1/responses`는 non-stream만 지원합니다. 스트리밍은 `/v1/chat/completions`을 쓰세요.
- 프록시 자체는 API key를 검사하지 않습니다. loopback 외 bind 시 네트워크 사용자가 사용자의 Google OAuth quota로 요청할 수 있으므로 기본 `127.0.0.1`을 유지하세요.
- Google이 Code Assist 계약·엔드포인트를 바꾸면 일시적으로 깨질 수 있습니다. Gemini CLI를 최신으로 유지하세요.
- **약관 리스크**: 구독 OAuth를 로컬 프록시로 재사용하는 것은 계정 정책과 충돌할 수 있습니다. 본인 계정·개인/내부 용도로만 사용하세요.

---

## 개발 및 검증

```bash
npm ci
npm run typecheck
npm test          # build + Node test runner
npm run check     # typecheck + test
npm pack --dry-run
```

자동 테스트는 요청 크기·입력 검증, OAuth state/error/token 처리, tool-call 변환, SSE fragmentation/cancellation, Responses stream 거절, IPv6 URL, CLI 옵션과 package bin 메타데이터를 다룹니다. 실제 계정 smoke test는 서버 실행 후 `examples/curl.sh`로 확인할 수 있습니다.

Free-tier 프로젝트 해석과 `generateContent` 호출 모두 Antigravity-compatible metadata를 사용합니다. 이 private API와 metadata는 Google 변경에 따라 깨질 수 있습니다.

---

## Legal

Unofficial, community-maintained. Not affiliated with, endorsed by, or sponsored by Google LLC / Antigravity.

Treat Gemini credentials like passwords. Use only your own account. Comply with Google Terms of Use and applicable policies. Provided as-is with no warranties.
