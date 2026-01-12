# Persistent Context Chatbot (Cloudflare Workers + Durable Objects)

A Cloudflare Workers app that provides a persistent-context chat API backed by Durable Objects (SQLite) and Workers AI (Llama 3.3). It includes a simple web UI, per-conversation memory, and a global daily output-token quota.

## Features

- Persistent per-conversation history stored in a Durable Object (SQLite)
- Context trimming based on token budget
- Global daily output-token cap (default: 10,000) across all conversations
- Simple browser UI at `/`
- API endpoints for chat, history, and reset

## Tech Stack

- Cloudflare Workers
- Durable Objects with SQLite storage
- Workers AI (Llama 3.3)
- TypeScript

## Project Structure

- `src/index.ts` Worker + Durable Object implementation
- `wrangler.jsonc` Worker configuration (bindings, migrations, AI binding)

## Prerequisites

- Node.js 18+ (or recent LTS)
- A Cloudflare account with Workers AI enabled
- Wrangler (already in dev dependencies)

## Setup

Install dependencies:

```bash
npm install
```

If you want typed bindings in `worker-configuration.d.ts`:

```bash
npm run cf-typegen
```

## Local Development

Start the dev server:

```bash
npm run dev
```

Open the UI:

- `http://localhost:8787/`
- `https://cf-ai-persistent-context-chatbot.adityasdutta.workers.dev`

### API Quick Test

```bash
curl -X POST http://localhost:8787/chat \
  -H "content-type: application/json" \
  -d '{"conversationId":"demo-1","message":"Hello"}'
```

Fetch history:

```bash
curl "http://localhost:8787/history?conversationId=demo-1"
```

Reset a conversation:

```bash
curl -X POST http://localhost:8787/reset \
  -H "content-type: application/json" \
  -d '{"conversationId":"demo-1"}'
```

## Deployment

Deploy to Cloudflare:

```bash
npm run deploy
```

## Configuration

### Model

The Workers AI model is set in `src/index.ts`:

```ts
const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
```

### Token Budgets

Tune these in `src/index.ts`:

```ts
const TOKEN_BUDGET = 4000;         // input token budget
const MAX_OUTPUT_TOKENS = 512;     // output token cap per response
const DAILY_OUTPUT_TOKEN_LIMIT = 10000; // global daily cap (free tier)
```

### System Prompt

The UI includes a system prompt field. It is persisted per conversation and used for future responses.

## API Reference

### POST /chat

Request:

```json
{
  "conversationId": "string",
  "message": "string",
  "systemPrompt": "string (optional)"
}
```

Response:

```json
{
  "reply": "string",
  "summary": "string | null",
  "usage": {
    "promptTokens": 123,
    "outputTokens": 45,
    "dailyLimit": 10000
  }
}
```

Errors:

- `429` when daily output quota is exceeded
- `502` for AI or quota service errors

### GET /history

Query:

- `conversationId`: string

Response:

```json
{
  "summary": "string | null",
  "messages": [
    { "id": 1, "role": "user", "content": "...", "createdAt": "..." }
  ]
}
```

### POST /reset

Request:

```json
{ "conversationId": "string" }
```

Response:

```json
{ "ok": true }
```

## Notes

- SQLite-backed Durable Objects require a new class name if you previously deployed a non-SQLite class.
- Workers AI calls are remote, even in local development.

## Troubleshooting

- **5007: No such model**: Verify the model ID in your Cloudflare dashboard and update `MODEL`.
- **Durable Object SQL error**: Ensure the Durable Object class is created with `new_sqlite_classes` and a new migration tag.
- **Build rate limit (429)**: Wait and retry; avoid rapid repeated deploys.
