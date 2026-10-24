/**
 * Acting as an agent (roleALPHA `agent:run`, RFC 8693). The runner holds one function
 * account; for every run it swaps the account token for a run token that carries exactly
 * the view of one agent, valid for 15 minutes. Without a run token nothing runs: there is
 * no fallback to the view of the account.
 *
 * Tokens stay in memory only and are never written to node output.
 */

export interface FormReply {
	status: number;
	body: string;
}

/** POSTs an x-www-form-urlencoded body; injected so the node uses n8n's helpers and tests fake it. */
export type FormPost = (url: string, form: Record<string, string>, headers: Record<string, string>) => Promise<FormReply>;

export interface FunctionAccount {
	tokenUrl: string;
	clientId: string;
	clientSecret: string;
	/** Where the client credentials go: Basic header (default) or form body. */
	authentication?: 'header' | 'body';
}

/** What the runner does on a refusal. The code decides, never the text. */
export type Reaction = 'fixConfig' | 'informAdmin' | 'removeAgent' | 'pause' | 'pauseUntilNextPeriod' | 'retryLater' | 'renewAccountToken' | 'endRun';

const REACTIONS: Record<string, Reaction> = {
	agent_uuid_fehlt: 'fixConfig',
	run_id_ungueltig: 'fixConfig',
	invalid_request: 'fixConfig',
	unsupported_grant_type: 'fixConfig',
	kein_agent_run_recht: 'informAdmin',
	agent_nicht_gebunden: 'informAdmin',
	funktionskonto_deaktiviert: 'informAdmin',
	funktion_nicht_freigeschaltet: 'informAdmin',
	mandant_stimmt_nicht: 'informAdmin',
	anker_fehlt: 'informAdmin',
	invalid_client: 'informAdmin',
	agent_unbekannt: 'removeAgent',
	agent_nicht_aktiv: 'pause',
	agent_budget_erschoepft: 'pauseUntilNextPeriod',
	agent_status_nicht_pruefbar: 'retryLater',
	token_ungueltig: 'renewAccountToken',
	falscher_token_typ: 'renewAccountToken',
	falsche_resource: 'renewAccountToken',
	funktionskonto_unbekannt: 'renewAccountToken',
	secret_widerrufen: 'renewAccountToken',
};

export function reactionFor(code: string, status = 0): Reaction {
	return REACTIONS[code] ?? (status === 401 ? 'renewAccountToken' : status >= 500 || status === 429 ? 'retryLater' : 'endRun');
}

export class AgentRunError extends Error {
	readonly reaction: Reaction;
	constructor(
		readonly code: string,
		readonly status: number,
		readonly description: string,
	) {
		super(`${code}${description ? `: ${description}` : ''}`);
		this.name = 'AgentRunError';
		this.reaction = reactionFor(code, status);
	}
}

const RUN_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Renew a token this long before it expires, so no call starts with a token about to lapse. */
const MARGIN_MS = 60_000;

export const GRANT_TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
export const TOKEN_TYPE_ACCESS = 'urn:ietf:params:oauth:token-type:access_token';

export function isValidRunId(runId: string): boolean {
	return RUN_ID.test(runId);
}

interface Cached {
	token: string;
	expiresAt: number;
}

export interface RunToken {
	token: string;
	expiresAt: number;
	agent: { uuid: string; name: string | null };
	runId: string;
}

function parse(body: string): Record<string, unknown> {
	try {
		const v = JSON.parse(body) as unknown;
		return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function refusal(reply: FormReply): AgentRunError {
	const b = parse(reply.body);
	const code = typeof b.error === 'string' && b.error ? b.error : `http_${reply.status}`;
	const description = typeof b.error_description === 'string' ? b.error_description : reply.body.slice(0, 300);
	return new AgentRunError(code, reply.status, description);
}

function basic(id: string, secret: string): string {
	return `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64')}`;
}

export interface TokenStore {
	accounts: Map<string, Cached>;
	runs: Map<string, RunToken>;
}

/** One store per process: the nodes and sub-workflows of one run swap once and share the token. */
export const PROCESS_STORE: TokenStore = { accounts: new Map(), runs: new Map() };

/** Holds the account token and the run tokens, kept per account, agent and run. */
export class AgentRunTokens {
	private readonly accounts: Map<string, Cached>;
	private readonly runs: Map<string, RunToken>;

	constructor(
		private readonly post: FormPost,
		private readonly now: () => number = Date.now,
		store: TokenStore = PROCESS_STORE,
	) {
		this.accounts = store.accounts;
		this.runs = store.runs;
	}

	private accountKey(a: FunctionAccount): string {
		return `${a.tokenUrl}|${a.clientId}`;
	}

	private async accountToken(a: FunctionAccount, fresh: boolean): Promise<string> {
		const key = this.accountKey(a);
		const hit = this.accounts.get(key);
		if (!fresh && hit && hit.expiresAt - MARGIN_MS > this.now()) return hit.token;
		const reply =
			a.authentication === 'body'
				? await this.post(a.tokenUrl, { grant_type: 'client_credentials', client_id: a.clientId, client_secret: a.clientSecret }, {})
				: await this.post(a.tokenUrl, { grant_type: 'client_credentials' }, { Authorization: basic(a.clientId, a.clientSecret) });
		if (reply.status !== 200) throw refusal(reply);
		const b = parse(reply.body);
		if (typeof b.access_token !== 'string' || !b.access_token) throw new AgentRunError('no_access_token', reply.status, 'The token endpoint returned no access_token');
		const token = { token: b.access_token, expiresAt: this.now() + (Number(b.expires_in) || 3600) * 1000 };
		this.accounts.set(key, token);
		return token.token;
	}

	/** The run token for one agent and run: cached, swapped again shortly before it expires. */
	async runToken(a: FunctionAccount, agentUuid: string, runId: string, opts: { fresh?: boolean } = {}): Promise<RunToken> {
		const agent = agentUuid.trim().toLowerCase();
		if (!UUID.test(agent)) throw new AgentRunError('agent_uuid_fehlt', 400, `Not an agent UUID: "${agentUuid}"`);
		if (!isValidRunId(runId)) throw new AgentRunError('run_id_ungueltig', 400, 'Run ID: 1-128 characters of A-Z a-z 0-9 . _ : -');
		const key = `${this.accountKey(a)}|${agent}|${runId}`;
		const hit = this.runs.get(key);
		if (!opts.fresh && hit && hit.expiresAt - MARGIN_MS > this.now()) return hit;
		this.prune();

		const swap = async (fresh: boolean) =>
			this.post(
				a.tokenUrl,
				{ grant_type: GRANT_TOKEN_EXCHANGE, subject_token: await this.accountToken(a, fresh), subject_token_type: TOKEN_TYPE_ACCESS, agent_uuid: agent, run_id: runId },
				{},
			);
		let reply = await swap(false);
		// A stale account token is renewed once; every other refusal is final for this call.
		if (reply.status !== 200 && reactionFor(refusal(reply).code, reply.status) === 'renewAccountToken') reply = await swap(true);
		if (reply.status !== 200) throw refusal(reply);

		const b = parse(reply.body);
		if (typeof b.access_token !== 'string' || !b.access_token) throw new AgentRunError('no_access_token', reply.status, 'The token exchange returned no access_token');
		const named = (b.agent ?? {}) as Record<string, unknown>;
		const token: RunToken = {
			token: b.access_token,
			expiresAt: this.now() + (Number(b.expires_in) || 900) * 1000,
			agent: { uuid: agent, name: typeof named.name === 'string' ? named.name : null },
			runId,
		};
		this.runs.set(key, token);
		return token;
	}

	/** Forgets a run token, e.g. after the MCP endpoint refused it. */
	forget(a: FunctionAccount, agentUuid: string, runId: string): void {
		this.runs.delete(`${this.accountKey(a)}|${agentUuid.trim().toLowerCase()}|${runId}`);
	}

	private prune(): void {
		const now = this.now();
		for (const [k, v] of this.runs) if (v.expiresAt <= now) this.runs.delete(k);
	}
}

/** Reads the refusal code of an MCP reply under a run token: JSON-RPC error.message or an OAuth error. */
export function mcpRefusalCode(body: string): string {
	const b = parse(body);
	const err = b.error as unknown;
	if (typeof err === 'string') return err;
	if (err && typeof err === 'object' && typeof (err as Record<string, unknown>).message === 'string') return String((err as Record<string, unknown>).message).trim().split(/\s/)[0];
	return '';
}
