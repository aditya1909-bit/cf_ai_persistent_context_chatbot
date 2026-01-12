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

const MODEL = "@cf/meta/llama-3.3-70b-instruct";
const TOKEN_BUDGET = 4000;
const MAX_OUTPUT_TOKENS = 512;
const TOKEN_CHAR_RATIO = 4;
const DAILY_OUTPUT_TOKEN_LIMIT = 10000;
const MAX_MESSAGES = 40;
const SUMMARIZE_BATCH = 20;
const MAX_SUMMARY_CHARS = 2000;

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

export class MyDurableObject extends DurableObject<Env> {
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

	private buildPromptMessages(history: ChatMessage[], summary: string | null): AiChatMessage[] {
		const baseMessages: AiChatMessage[] = [
			{ role: "system", content: "You are a helpful assistant." },
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
	): Promise<string> {
		const messages = this.buildPromptMessages(history, summary);
		const result = await this.env.AI.run(MODEL, {
			messages,
			max_tokens: MAX_OUTPUT_TOKENS,
			temperature: 0.2,
		});
		const reply = this.extractAiReply(result);
		if (!reply) {
			throw new Error("Empty AI response");
		}
		return reply.trim();
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
						{ error: "Daily AI quota exceeded. Try again tomorrow." },
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

			this.insertMessage("user", payload.message);
			const summary = this.getSummary();
			const history = this.listRecentMessages(MAX_MESSAGES);
			try {
				const reply = await this.generateAssistantReply(history, summary);
				const outputTokens = Math.min(
					this.estimateTokens(reply),
					reservation?.maxTokens ?? MAX_OUTPUT_TOKENS,
				);
				await this.commitQuota(reservation?.maxTokens ?? MAX_OUTPUT_TOKENS, outputTokens);
				this.insertMessage("assistant", reply);
				this.summarizeIfNeeded();

				return jsonResponse({ reply, summary: this.getSummary() });
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
			return jsonResponse({ ok: true });
		}

		return errorResponse("Not found", 404);
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
