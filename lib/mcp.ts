/**
 * Minimal MCP client over Streamable HTTP. The transport is injected so the
 * node can route requests through n8n's credential helpers and tests can fake it.
 */

export interface HttpReply {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: string;
}

export type Transport = (body: unknown, headers: Record<string, string>) => Promise<HttpReply>;

export class McpError extends Error {
	constructor(
		message: string,
		readonly code?: number,
	) {
		super(message);
		this.name = 'McpError';
	}
}

interface JsonRpcMessage {
	jsonrpc?: string;
	id?: number | string | null;
	result?: unknown;
	error?: { code?: number; message?: string };
}

function header(headers: HttpReply['headers'], name: string): string | undefined {
	const wanted = name.toLowerCase();
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === wanted) {
			const value = headers[key];
			return Array.isArray(value) ? value[0] : value;
		}
	}
	return undefined;
}

/** Reads a JSON-RPC reply that arrived either as plain JSON or as an SSE stream. */
export function parseRpcBody(body: string, id?: number | string): JsonRpcMessage {
	const text = (body ?? '').trim();
	if (text === '') throw new McpError('Empty MCP response');
	if (text.startsWith('{') || text.startsWith('[')) {
		const parsed = JSON.parse(text) as JsonRpcMessage | JsonRpcMessage[];
		return pick(Array.isArray(parsed) ? parsed : [parsed], id);
	}
	const messages: JsonRpcMessage[] = [];
	let data: string[] = [];
	const flush = () => {
		if (data.length > 0) {
			try {
				messages.push(JSON.parse(data.join('\n')) as JsonRpcMessage);
			} catch {
				// Ignore non-JSON events such as keep-alives.
			}
		}
		data = [];
	};
	for (const line of text.split(/\r?\n/)) {
		if (line === '') flush();
		else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
	}
	flush();
	return pick(messages, id);
}

function pick(messages: JsonRpcMessage[], id?: number | string): JsonRpcMessage {
	const replies = messages.filter((m) => m && ('result' in m || 'error' in m));
	const match = id === undefined ? replies[0] : replies.find((m) => m.id === id) ?? replies[0];
	if (!match) throw new McpError('MCP response contained no JSON-RPC result');
	return match;
}

/** Unwraps a tools/call result. `content[].text` may be a JSON string or an object. */
export function unwrapToolResult(result: unknown): unknown {
	const r = (result ?? {}) as {
		isError?: boolean;
		structuredContent?: unknown;
		content?: Array<{ type?: string; text?: unknown }>;
	};
	const texts = (r.content ?? []).filter((c) => c && c.text !== undefined).map((c) => c.text);
	if (r.isError) {
		const message = texts.map((t) => (typeof t === 'string' ? t : JSON.stringify(t))).join(' ');
		throw new McpError(message || 'MCP tool reported an error');
	}
	if (r.structuredContent !== undefined && r.structuredContent !== null) return r.structuredContent;
	const values = texts.map((t) => {
		if (typeof t !== 'string') return t;
		try {
			return JSON.parse(t) as unknown;
		} catch {
			return t;
		}
	});
	return values.length === 1 ? values[0] : values;
}

/** Waits before a repeated call; injected so tests run without delay. */
export type Sleep = (ms: number) => Promise<void>;

const sleepFor: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Repeats of a call the server turned away for load (429, 503) or answered empty. */
const RETRIES = 4;
const MAX_WAIT_MS = 30_000;

/** Wait before repeat `attempt` (0-based): Retry-After if the server sent one, else 1, 2, 4, 8 s plus jitter. */
export function retryDelay(reply: HttpReply | undefined, attempt: number, random: () => number = Math.random): number {
	const after = reply ? header(reply.headers, 'retry-after') : undefined;
	const seconds = after !== undefined && /^\d+(\.\d+)?$/.test(after.trim()) ? Number(after) : NaN;
	const base = Number.isFinite(seconds) ? seconds * 1000 : 1000 * 2 ** attempt;
	return Math.min(MAX_WAIT_MS, Math.round(base + random() * 500));
}

/** A tool whose name says it only reads may be called again after an empty reply. */
const READ_TOOL = /^(get|search|find|list|check|query|describe)_/;

export class McpClient {
	private sessionId?: string;
	private nextId = 1;
	private ready?: Promise<void>;
	private renewing = false;

	constructor(
		private readonly transport: Transport,
		private readonly clientName = 'n8n-nodes-rolealpha',
		private readonly sleep: Sleep = sleepFor,
	) {}

	/** Sends one request; repeats it while the server turns it away for load. */
	private async send(method: string, params: unknown, payload: Record<string, unknown>, headers: Record<string, string>, notification: boolean): Promise<HttpReply> {
		const tool = method === 'tools/call' ? String((params as { name?: unknown })?.name ?? '') : '';
		const mayRepeatEmpty = !notification && (method !== 'tools/call' || READ_TOOL.test(tool));
		for (let attempt = 0; ; attempt++) {
			const reply = await this.transport(payload, headers);
			// An exhausted agent budget is final; anything else under 429 or 503 is load and passes.
			const busy = (reply.status === 429 || reply.status === 503) && !/agent_budget_erschoepft/.test(reply.body ?? '');
			const empty = mayRepeatEmpty && reply.status < 400 && (reply.body ?? '').trim() === '';
			if ((!busy && !empty) || attempt >= RETRIES) return reply;
			await this.sleep(retryDelay(reply, attempt));
		}
	}

	private async rpc(method: string, params: unknown, notification = false): Promise<unknown> {
		const id = notification ? undefined : this.nextId++;
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
		};
		if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
		const payload: Record<string, unknown> = { jsonrpc: '2.0', method, params };
		if (id !== undefined) payload.id = id;
		const reply = await this.send(method, params, payload, headers, notification);
		// The server forgot the session (e.g. after a release): open a new one once and repeat the call.
		if (reply.status === 404 && this.sessionId && method !== 'initialize' && !notification && !this.renewing) {
			this.sessionId = undefined;
			this.ready = undefined;
			this.renewing = true;
			try {
				await this.initialize();
				return await this.rpc(method, params);
			} finally {
				this.renewing = false;
			}
		}
		const session = header(reply.headers, 'mcp-session-id');
		if (session) this.sessionId = session;
		if (reply.status >= 400) {
			throw new McpError(`MCP ${method} failed with HTTP ${reply.status}: ${reply.body.slice(0, 300)}`, reply.status);
		}
		if (notification) return undefined;
		const message = parseRpcBody(reply.body, id);
		if (message.error) throw new McpError(message.error.message ?? 'MCP error', message.error.code);
		return message.result;
	}

	private initialize(): Promise<void> {
		if (!this.ready) {
			this.ready = (async () => {
				await this.rpc('initialize', {
					protocolVersion: '2025-06-18',
					capabilities: {},
					clientInfo: { name: this.clientName, version: '0.1.0' },
				});
				await this.rpc('notifications/initialized', {}, true);
			})();
		}
		return this.ready;
	}

	async listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
		await this.initialize();
		const tools: Array<{ name: string; description?: string; inputSchema?: unknown }> = [];
		let cursor: string | undefined;
		for (let page = 0; page < 20; page++) {
			const res = (await this.rpc('tools/list', cursor ? { cursor } : {})) as { tools?: typeof tools; nextCursor?: string };
			tools.push(...(res?.tools ?? []));
			if (!res?.nextCursor) break;
			cursor = res.nextCursor;
		}
		return tools;
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
		await this.initialize();
		const result = await this.rpc('tools/call', { name, arguments: args });
		return unwrapToolResult(result);
	}
}
