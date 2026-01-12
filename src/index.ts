import { DurableObject } from "cloudflare:workers";

/**
 * Welcome to Cloudflare Workers! This is your first Durable Objects application.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your Durable Object in action
 * - Run `npm run deploy` to publish your application
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/durable-objects
 */

/** A Durable Object's behavior is defined in an exported Javascript class */
type ChatRole = "user" | "assistant" | "system";

type ChatMessage = {
	id: number;
	role: ChatRole;
	content: string;
	createdAt: string;
};

type ChatRequest = {
	message: string;
	systemPrompt?: string;
};

type AiChatMessage = {
	role: ChatRole;
	content: string;
};

type AiRunOptions = {
	messages: AiChatMessage[];
	max_tokens?: number;
	temperature?: number;
};

type AiRunResult = {
	response?: string;
	message?: { content?: string };
	output_text?: string;
};

type AiBinding = {
	run: (model: string, options: AiRunOptions) => Promise<AiRunResult | string>;
};

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const TOKEN_BUDGET = 4000;
const MAX_OUTPUT_TOKENS = 512;
const TOKEN_CHAR_RATIO = 4;
const DAILY_OUTPUT_TOKEN_LIMIT = 10000;
const MAX_MESSAGES = 40;
const SUMMARIZE_BATCH = 20;
const MAX_SUMMARY_CHARS = 2000;

const CHAT_UI_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Context Chat</title>
    <style>
      :root {
        --bg-1: #f7f1e8;
        --bg-2: #f3e6d0;
        --bg-3: #fbe7cc;
        --ink: #1f1b16;
        --muted: #6a5f54;
        --accent: #c9572c;
        --card: #fffaf2;
        --shadow: rgba(31, 27, 22, 0.12);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Space Grotesk", "Segoe UI", system-ui, sans-serif;
        color: var(--ink);
        background:
          radial-gradient(1200px 800px at 10% 10%, var(--bg-3), transparent 60%),
          radial-gradient(900px 600px at 90% 20%, #f1dcc6, transparent 55%),
          linear-gradient(140deg, var(--bg-1), var(--bg-2));
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 32px 16px;
      }
      .shell {
        width: min(880px, 100%);
        background: var(--card);
        border-radius: 28px;
        box-shadow: 0 20px 60px var(--shadow);
        padding: 28px;
        display: grid;
        gap: 20px;
        position: relative;
        overflow: hidden;
      }
      .shell::before {
        content: "";
        position: absolute;
        inset: -60% 30% auto -40%;
        height: 200px;
        background: linear-gradient(120deg, rgba(201, 87, 44, 0.16), transparent);
        transform: rotate(-8deg);
        pointer-events: none;
      }
      header {
        display: flex;
        align-items: baseline;
        gap: 12px;
      }
      h1 {
        font-size: clamp(1.6rem, 2vw + 1.2rem, 2.6rem);
        margin: 0;
        letter-spacing: -0.02em;
      }
      .tag {
        font-size: 0.85rem;
        color: var(--muted);
        letter-spacing: 0.2em;
        text-transform: uppercase;
      }
      .messages {
        display: grid;
        gap: 14px;
        max-height: 52vh;
        overflow-y: auto;
        padding-right: 6px;
      }
      .msg {
        padding: 14px 16px;
        border-radius: 16px;
        background: #f1ebe2;
        line-height: 1.4;
        animation: rise 0.3s ease both;
      }
      .msg.user {
        background: #f7d8c1;
        justify-self: end;
      }
      .msg.assistant {
        background: #f1f0ee;
        border: 1px solid #eadfd3;
      }
      .composer {
        display: grid;
        grid-template-columns: 1fr;
        gap: 12px;
        align-items: center;
      }
      .controls {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 12px;
        align-items: center;
      }
      .system-prompt {
        display: grid;
        gap: 6px;
      }
      .system-prompt label {
        font-size: 0.85rem;
        color: var(--muted);
      }
      textarea {
        width: 100%;
        min-height: 56px;
        max-height: 140px;
        resize: vertical;
        border-radius: 16px;
        border: 1px solid #e2d5c7;
        padding: 12px 14px;
        font: inherit;
        background: #fffdf9;
      }
      button {
        border: none;
        background: var(--accent);
        color: white;
        font-weight: 600;
        padding: 14px 20px;
        border-radius: 999px;
        cursor: pointer;
        transition: transform 0.15s ease, box-shadow 0.15s ease;
        box-shadow: 0 10px 20px rgba(201, 87, 44, 0.25);
      }
      .ghost {
        background: transparent;
        color: var(--accent);
        border: 1px solid rgba(201, 87, 44, 0.35);
        box-shadow: none;
      }
      button:active { transform: translateY(1px) scale(0.98); }
      .meta {
        display: flex;
        justify-content: space-between;
        flex-wrap: wrap;
        font-size: 0.85rem;
        color: var(--muted);
      }
      .meta strong {
        color: var(--ink);
      }
      @keyframes rise {
        from { opacity: 0; transform: translateY(6px); }
        to { opacity: 1; transform: translateY(0); }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <header>
        <h1>Context Chat</h1>
        <span class="tag">persistent memory</span>
      </header>
      <section class="messages" id="messages"></section>
      <div class="meta">
        <span id="conversation"></span>
        <span id="usage"></span>
        <span id="status">Ready</span>
      </div>
      <form class="composer" id="composer">
        <div class="system-prompt">
          <label for="system">System prompt</label>
          <textarea id="system" placeholder="Define behavior for the assistant..."></textarea>
        </div>
        <div class="controls">
          <textarea id="input" placeholder="Say something thoughtful..." required></textarea>
          <button type="submit">Send</button>
        </div>
        <div class="controls">
          <button type="button" class="ghost" id="reset">Clear chat</button>
        </div>
      </form>
    </main>
    <script>
      const messagesEl = document.getElementById("messages");
      const inputEl = document.getElementById("input");
      const statusEl = document.getElementById("status");
      const usageEl = document.getElementById("usage");
      const conversationEl = document.getElementById("conversation");
      const systemEl = document.getElementById("system");
      const conversationId = localStorage.getItem("conversationId") || crypto.randomUUID();
      localStorage.setItem("conversationId", conversationId);
      conversationEl.textContent = "Conversation: " + conversationId.slice(0, 8);
      systemEl.value = localStorage.getItem("systemPrompt") || "";

      function addMessage(role, content) {
        const div = document.createElement("div");
        div.className = "msg " + role;
        div.textContent = content;
        messagesEl.appendChild(div);
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }

      async function loadHistory() {
        try {
          const res = await fetch("/history?conversationId=" + conversationId);
          if (!res.ok) return;
          const data = await res.json();
          if (Array.isArray(data.messages)) {
            data.messages.forEach((msg) => addMessage(msg.role, msg.content));
          }
        } catch (err) {
          console.error(err);
        }
      }

      async function sendMessage(message) {
        statusEl.textContent = "Thinking...";
        const res = await fetch("/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            conversationId,
            message,
            systemPrompt: systemEl.value.trim() || undefined,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          statusEl.textContent = "Error";
          addMessage("assistant", data.error || "Request failed");
          return;
        }
        statusEl.textContent = "Ready";
        if (data.usage) {
          usageEl.innerHTML = "Tokens: <strong>" + data.usage.outputTokens + "</strong> / " + data.usage.dailyLimit;
        }
        addMessage("assistant", data.reply);
      }

      document.getElementById("composer").addEventListener("submit", async (event) => {
        event.preventDefault();
        const message = inputEl.value.trim();
        if (!message) return;
        inputEl.value = "";
        addMessage("user", message);
        const nextSystem = systemEl.value.trim();
        if (nextSystem !== localStorage.getItem("systemPrompt")) {
          localStorage.setItem("systemPrompt", nextSystem);
        }
        await sendMessage(message);
      });

      document.getElementById("reset").addEventListener("click", async () => {
        statusEl.textContent = "Clearing...";
        await fetch("/reset", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ conversationId }),
        });
        messagesEl.innerHTML = "";
        statusEl.textContent = "Ready";
        usageEl.textContent = "";
      });

      loadHistory();
    </script>
  </body>
</html>`;

const corsHeaders = {
	"access-control-allow-origin": "*",
	"access-control-allow-methods": "GET,POST,OPTIONS",
	"access-control-allow-headers": "content-type",
};

function jsonResponse(data: unknown, init?: ResponseInit): Response {
	const headers = new Headers(init?.headers);
	headers.set("content-type", "application/json");
	for (const [key, value] of Object.entries(corsHeaders)) {
		if (!headers.has(key)) headers.set(key, value);
	}
	return new Response(JSON.stringify(data, null, 2), { ...init, headers });
}

function errorResponse(message: string, status = 400): Response {
	return jsonResponse({ error: message }, { status });
}

function formatSummaryLine(message: Pick<ChatMessage, "role" | "content">): string {
	return `${message.role}: ${message.content}`;
}

export class ChatDurableObject extends DurableObject<Env> {
	private sql: DurableObjectState["storage"]["sql"];
	private env: Env & { AI: AiBinding };

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		this.env = env as Env & { AI: AiBinding };
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS messages (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				role TEXT NOT NULL,
				content TEXT NOT NULL,
				created_at TEXT NOT NULL
			);
		`);
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS kv (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
		`);
	}

	private getKvValue(key: string): string | null {
		const row = this.sql
			.exec("SELECT value FROM kv WHERE key = ?", key)
			.toArray()[0] as { value?: string } | undefined;
		return row?.value ?? null;
	}

	private setKvValue(key: string, value: string): void {
		this.sql.exec(
			"INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			key,
			value,
		);
	}

	private getSummary(): string | null {
		return this.getKvValue("summary");
	}

	private setSummary(summary: string): void {
		this.setKvValue("summary", summary);
	}

	private getSystemPrompt(): string | null {
		return this.getKvValue("system_prompt");
	}

	private setSystemPrompt(prompt: string | null): void {
		if (!prompt) {
			this.sql.exec("DELETE FROM kv WHERE key = ?", "system_prompt");
			return;
		}
		this.setKvValue("system_prompt", prompt);
	}

	private insertMessage(role: ChatRole, content: string): void {
		this.sql.exec(
			"INSERT INTO messages (role, content, created_at) VALUES (?, ?, ?)",
			role,
			content,
			new Date().toISOString(),
		);
	}

	private listRecentMessages(limit: number): ChatMessage[] {
		const rows = this.sql
			.exec(
				"SELECT id, role, content, created_at FROM messages ORDER BY id DESC LIMIT ?",
				limit,
			)
			.toArray() as Array<{
			id: number;
			role: ChatRole;
			content: string;
			created_at: string;
		}>;
		return rows
			.reverse()
			.map((row) => ({
				id: row.id,
				role: row.role,
				content: row.content,
				createdAt: row.created_at,
			}));
	}

	private countMessages(): number {
		const row = this.sql.exec("SELECT COUNT(*) AS count FROM messages").toArray()[0] as
			| { count?: number }
			| undefined;
		return row?.count ?? 0;
	}

	private summarizeIfNeeded(): void {
		const total = this.countMessages();
		if (total <= MAX_MESSAGES) return;

		const rows = this.sql
			.exec(
				"SELECT id, role, content FROM messages ORDER BY id ASC LIMIT ?",
				SUMMARIZE_BATCH,
			)
			.toArray() as Array<{ id: number; role: ChatRole; content: string }>;
		if (rows.length === 0) return;

		const previousSummary = this.getSummary();
		const newLines = rows.map((row) =>
			formatSummaryLine({ role: row.role, content: row.content }),
		);
		let summary = [previousSummary, ...newLines].filter(Boolean).join("\n");
		if (summary.length > MAX_SUMMARY_CHARS) {
			summary = summary.slice(summary.length - MAX_SUMMARY_CHARS);
		}
		this.setSummary(summary);

		const lastId = rows[rows.length - 1].id;
		this.sql.exec("DELETE FROM messages WHERE id <= ?", lastId);
	}

	private getTodayKey(): string {
		return new Date().toISOString().slice(0, 10);
	}

	private getQuotaState(): { date: string; used: number; reserved: number } {
		const today = this.getTodayKey();
		const storedDate = this.getKvValue("quota_date");
		let used = Number.parseInt(this.getKvValue("quota_used") ?? "0", 10);
		let reserved = Number.parseInt(this.getKvValue("quota_reserved") ?? "0", 10);
		let date = storedDate ?? today;

		if (date !== today) {
			date = today;
			used = 0;
			reserved = 0;
			this.setQuotaState({ date, used, reserved });
		}

		return { date, used, reserved };
	}

	private setQuotaState(state: { date: string; used: number; reserved: number }): void {
		this.setKvValue("quota_date", state.date);
		this.setKvValue("quota_used", String(state.used));
		this.setKvValue("quota_reserved", String(state.reserved));
	}

	private async reserveQuota(maxTokens: number): Promise<{
		allowed: boolean;
		remaining: number;
		maxTokens: number;
	}> {
		const stub = this.env.MY_DURABLE_OBJECT.get(
			this.env.MY_DURABLE_OBJECT.idFromName("global-quota"),
		);
		const response = await stub.fetch("https://quota.local/quota/reserve", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ maxTokens }),
		});
		if (!response.ok) {
			throw new Error("Quota service unavailable");
		}
		return (await response.json()) as {
			allowed: boolean;
			remaining: number;
			maxTokens: number;
		};
	}

	private async commitQuota(maxTokens: number, actualTokens: number): Promise<void> {
		const stub = this.env.MY_DURABLE_OBJECT.get(
			this.env.MY_DURABLE_OBJECT.idFromName("global-quota"),
		);
		await stub.fetch("https://quota.local/quota/commit", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ maxTokens, actualTokens }),
		});
	}

	private estimateTokens(text: string): number {
		return Math.ceil(text.length / TOKEN_CHAR_RATIO);
	}

	private estimateMessageTokens(messages: AiChatMessage[]): number {
		return messages.reduce((total, message) => {
			return total + this.estimateTokens(message.role) + this.estimateTokens(message.content) + 4;
		}, 0);
	}

	private buildPromptMessages(
		history: ChatMessage[],
		summary: string | null,
		systemPrompt: string | null,
	): AiChatMessage[] {
		const baseMessages: AiChatMessage[] = [
			{
				role: "system",
				content: systemPrompt?.trim() || "You are a helpful assistant.",
			},
		];
		let summaryMessage: AiChatMessage | null = null;
		if (summary) {
			summaryMessage = {
				role: "system",
				content: `Conversation summary:\n${summary}`,
			};
		}

		let historyMessages = history.map((message) => ({
			role: message.role,
			content: message.content,
		}));

		const inputBudget = Math.max(TOKEN_BUDGET - MAX_OUTPUT_TOKENS, 256);
		const buildMessages = () => [
			...baseMessages,
			...(summaryMessage ? [summaryMessage] : []),
			...historyMessages,
		];

		let messages = buildMessages();
		let overBudget = this.estimateMessageTokens(messages) - inputBudget;

		while (overBudget > 0 && historyMessages.length > 1) {
			historyMessages.shift();
			messages = buildMessages();
			overBudget = this.estimateMessageTokens(messages) - inputBudget;
		}

		if (overBudget > 0 && summaryMessage) {
			const summaryPrefix = "Conversation summary:\n";
			const baseTokens = this.estimateMessageTokens([
				...baseMessages,
				...historyMessages,
			]);
			const allowedSummaryTokens = Math.max(0, inputBudget - baseTokens);
			const allowedSummaryChars = Math.max(0, allowedSummaryTokens * TOKEN_CHAR_RATIO);
			const rawSummary = summaryMessage.content.slice(summaryPrefix.length);
			const trimmedSummary =
				allowedSummaryChars <= summaryPrefix.length
					? ""
					: rawSummary.slice(
							Math.max(0, rawSummary.length - (allowedSummaryChars - summaryPrefix.length)),
						);
			summaryMessage = {
				role: "system",
				content: trimmedSummary
					? `${summaryPrefix}${trimmedSummary}`
					: `${summaryPrefix}(omitted due to token budget)`,
			};
			messages = buildMessages();
		}

		return messages;
	}

	private extractAiReply(result: AiRunResult | string): string | null {
		if (typeof result === "string") return result;
		if (result?.response && typeof result.response === "string") return result.response;
		if (result?.message?.content && typeof result.message.content === "string") {
			return result.message.content;
		}
		if (result?.output_text && typeof result.output_text === "string") return result.output_text;
		return null;
	}

	private async generateAssistantReply(
		history: ChatMessage[],
		summary: string | null,
		systemPrompt: string | null,
	): Promise<{ reply: string; promptTokens: number }> {
		const messages = this.buildPromptMessages(history, summary, systemPrompt);
		const promptTokens = this.estimateMessageTokens(messages);
		const result = await this.env.AI.run(MODEL, {
			messages,
			max_tokens: MAX_OUTPUT_TOKENS,
			temperature: 0.2,
		});
		const reply = this.extractAiReply(result);
		if (!reply) {
			throw new Error("Empty AI response");
		}
		return { reply: reply.trim(), promptTokens };
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: corsHeaders });
		}

		if (url.pathname === "/quota/reserve") {
			if (request.method !== "POST") {
				return errorResponse("POST required for /quota/reserve", 405);
			}
			let payload: { maxTokens?: number };
			try {
				payload = (await request.json()) as { maxTokens?: number };
			} catch {
				return errorResponse("Invalid JSON body");
			}
			const maxTokens = Number(payload.maxTokens ?? 0);
			if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
				return errorResponse("maxTokens must be a positive number");
			}
			const state = this.getQuotaState();
			const remaining = Math.max(
				0,
				DAILY_OUTPUT_TOKEN_LIMIT - state.used - state.reserved,
			);
			if (remaining < maxTokens) {
				return jsonResponse({ allowed: false, remaining, maxTokens });
			}
			const nextState = {
				...state,
				reserved: state.reserved + maxTokens,
			};
			this.setQuotaState(nextState);
			return jsonResponse({
				allowed: true,
				remaining: DAILY_OUTPUT_TOKEN_LIMIT - nextState.used - nextState.reserved,
				maxTokens,
			});
		}

		if (url.pathname === "/quota/commit") {
			if (request.method !== "POST") {
				return errorResponse("POST required for /quota/commit", 405);
			}
			let payload: { maxTokens?: number; actualTokens?: number };
			try {
				payload = (await request.json()) as {
					maxTokens?: number;
					actualTokens?: number;
				};
			} catch {
				return errorResponse("Invalid JSON body");
			}
			const maxTokens = Number(payload.maxTokens ?? 0);
			const actualTokens = Number(payload.actualTokens ?? 0);
			if (
				!Number.isFinite(maxTokens) ||
				!Number.isFinite(actualTokens) ||
				maxTokens < 0 ||
				actualTokens < 0
			) {
				return errorResponse("maxTokens and actualTokens must be numbers >= 0");
			}
			const state = this.getQuotaState();
			const reserved = Math.max(0, state.reserved - maxTokens);
			const used = state.used + actualTokens;
			this.setQuotaState({ ...state, reserved, used });
			return jsonResponse({ ok: true, remaining: DAILY_OUTPUT_TOKEN_LIMIT - used - reserved });
		}

		if (url.pathname === "/chat") {
			if (request.method !== "POST") {
				return errorResponse("POST required for /chat", 405);
			}

			let payload: ChatRequest;
			try {
				payload = (await request.json()) as ChatRequest;
			} catch {
				return errorResponse("Invalid JSON body");
			}

			if (!payload?.message || typeof payload.message !== "string") {
				return errorResponse("message is required");
			}

			let reservation: { maxTokens: number } | null = null;
			try {
				const quota = await this.reserveQuota(MAX_OUTPUT_TOKENS);
				if (!quota.allowed) {
					return jsonResponse(
						{
							error:
								"No more chats are available for today. Please come back tomorrow.",
						},
						{ status: 429 },
					);
				}
				reservation = { maxTokens: quota.maxTokens };
			} catch (error) {
				return errorResponse(
					error instanceof Error ? error.message : "Quota check failed",
					502,
				);
			}

			if (typeof payload.systemPrompt === "string") {
				this.setSystemPrompt(payload.systemPrompt.trim() || null);
			}
			this.insertMessage("user", payload.message);
			const summary = this.getSummary();
			const history = this.listRecentMessages(MAX_MESSAGES);
			try {
				const systemPrompt = this.getSystemPrompt();
				const result = await this.generateAssistantReply(history, summary, systemPrompt);
				const outputTokens = Math.min(
					this.estimateTokens(result.reply),
					reservation?.maxTokens ?? MAX_OUTPUT_TOKENS,
				);
				await this.commitQuota(reservation?.maxTokens ?? MAX_OUTPUT_TOKENS, outputTokens);
				this.insertMessage("assistant", result.reply);
				this.summarizeIfNeeded();

				return jsonResponse({
					reply: result.reply,
					summary: this.getSummary(),
					usage: {
						promptTokens: result.promptTokens,
						outputTokens,
						dailyLimit: DAILY_OUTPUT_TOKEN_LIMIT,
					},
				});
			} catch (error) {
				if (reservation) {
					await this.commitQuota(reservation.maxTokens, 0);
				}
				return errorResponse(
					error instanceof Error ? error.message : "AI request failed",
					502,
				);
			}
		}

		if (url.pathname === "/history") {
			if (request.method !== "GET") {
				return errorResponse("GET required for /history", 405);
			}
			const summary = this.getSummary();
			const history = this.listRecentMessages(MAX_MESSAGES);
			return jsonResponse({ summary, messages: history });
		}

		if (url.pathname === "/reset") {
			if (request.method !== "POST") {
				return errorResponse("POST required for /reset", 405);
			}
			this.sql.exec("DELETE FROM messages");
			this.sql.exec("DELETE FROM kv WHERE key = ?", "summary");
			this.sql.exec("DELETE FROM kv WHERE key = ?", "system_prompt");
			return jsonResponse({ ok: true });
		}

		return errorResponse("Not found", 404);
	}
}

// Legacy class retained for existing Durable Objects in production.
export class MyDurableObject extends DurableObject<Env> {
	async fetch(): Promise<Response> {
		return errorResponse("Legacy Durable Object no longer supported.", 410);
	}
}

function getConversationIdFromRequest(request: Request): string | null {
	const url = new URL(request.url);
	if (request.method === "GET") {
		return url.searchParams.get("conversationId");
	}
	return null;
}

async function getConversationIdFromBody(request: Request): Promise<string | null> {
	try {
		const payload = (await request.json()) as { conversationId?: string };
		return payload.conversationId ?? null;
	} catch {
		return null;
	}
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: corsHeaders });
		}

		if (url.pathname === "/") {
			return new Response(CHAT_UI_HTML, {
				headers: { "content-type": "text/html; charset=utf-8" },
			});
		}

		if (!["/chat", "/history", "/reset"].includes(url.pathname)) {
			return errorResponse("Not found", 404);
		}

		let conversationId = getConversationIdFromRequest(request);
		if (!conversationId && request.method !== "GET") {
			const cloned = request.clone();
			conversationId = await getConversationIdFromBody(cloned);
		}

		if (!conversationId) {
			return errorResponse("conversationId is required");
		}

		const stub = env.MY_DURABLE_OBJECT.get(
			env.MY_DURABLE_OBJECT.idFromName(conversationId),
		);

		let forwardRequest = request;
		if (request.method !== "GET") {
			const payload = (await request.json()) as Record<string, unknown>;
			delete payload.conversationId;
			forwardRequest = new Request(new URL(url.pathname, url.origin), {
				method: request.method,
				headers: request.headers,
				body: JSON.stringify(payload),
			});
		} else {
			forwardRequest = new Request(new URL(url.pathname, url.origin), {
				method: "GET",
				headers: request.headers,
			});
		}

		return stub.fetch(forwardRequest);
	},
} satisfies ExportedHandler<Env>;
