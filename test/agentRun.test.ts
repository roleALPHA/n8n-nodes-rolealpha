import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRunError, AgentRunTokens, GRANT_TOKEN_EXCHANGE, isValidRunId, mcpRefusalCode, reactionFor, type FormReply, type TokenStore } from '../lib/agentRun';

const ACCOUNT = { tokenUrl: 'https://ra.test/oauth/token', clientId: 'fk_1', clientSecret: 's3cret' };
const AGENT = 'a1000000-0000-4000-8000-000000000001';

interface Call {
	form: Record<string, string>;
	headers: Record<string, string>;
}

function fakeServer(replies: Array<(c: Call) => FormReply>) {
	const calls: Call[] = [];
	const post = async (_url: string, form: Record<string, string>, headers: Record<string, string>) => {
		const c = { form, headers };
		calls.push(c);
		const next = replies.shift();
		if (!next) throw new Error('unexpected call');
		return next(c);
	};
	return { calls, post };
}

const ok = (body: unknown): FormReply => ({ status: 200, body: JSON.stringify(body) });
const err = (status: number, error: string): FormReply => ({ status, body: JSON.stringify({ error, error_description: `Grund: ${error}` }) });
const freshStore = (): TokenStore => ({ accounts: new Map(), runs: new Map() });

test('agent run: account token, then exchange; the run token is cached per agent and run', async () => {
	const s = fakeServer([
		() => ok({ access_token: 'acct', expires_in: 3600 }),
		() => ok({ access_token: 'run-1', expires_in: 900, agent: { uuid: AGENT, name: 'Texter' }, run_id: 'exec-1' }),
	]);
	let now = 1_000_000;
	const tokens = new AgentRunTokens(s.post, () => now, freshStore());
	const t = await tokens.runToken(ACCOUNT, AGENT.toUpperCase(), 'exec-1');
	assert.equal(t.token, 'run-1');
	assert.equal(t.agent.name, 'Texter');
	assert.equal(s.calls[0].form.grant_type, 'client_credentials');
	assert.match(s.calls[0].headers.Authorization, /^Basic /);
	assert.deepEqual(s.calls[1].form, { grant_type: GRANT_TOKEN_EXCHANGE, subject_token: 'acct', subject_token_type: 'urn:ietf:params:oauth:token-type:access_token', agent_uuid: AGENT, run_id: 'exec-1' });

	now += 5 * 60_000;
	assert.equal((await tokens.runToken(ACCOUNT, AGENT, 'exec-1')).token, 'run-1', 'still valid: no second swap');
	assert.equal(s.calls.length, 2);
});

test('agent run: a run token about to expire is swapped again with the cached account token', async () => {
	const s = fakeServer([() => ok({ access_token: 'acct', expires_in: 3600 }), () => ok({ access_token: 'run-1', expires_in: 900 }), () => ok({ access_token: 'run-2', expires_in: 900 })]);
	let now = 0;
	const tokens = new AgentRunTokens(s.post, () => now, freshStore());
	await tokens.runToken(ACCOUNT, AGENT, 'exec-1');
	now += 14.5 * 60_000;
	assert.equal((await tokens.runToken(ACCOUNT, AGENT, 'exec-1')).token, 'run-2');
	assert.equal(s.calls.length, 3);
	assert.equal(s.calls[2].form.subject_token, 'acct');
});

test('agent run: a stale account token is renewed once', async () => {
	const s = fakeServer([
		() => ok({ access_token: 'old', expires_in: 3600 }),
		() => err(401, 'token_ungueltig'),
		() => ok({ access_token: 'new', expires_in: 3600 }),
		(c) => (c.form.subject_token === 'new' ? ok({ access_token: 'run', expires_in: 900 }) : err(401, 'token_ungueltig')),
	]);
	const tokens = new AgentRunTokens(s.post, Date.now, freshStore());
	assert.equal((await tokens.runToken(ACCOUNT, AGENT, 'exec-1')).token, 'run');
});

test('agent run: a refusal carries its code and the reaction; no fallback', async () => {
	for (const [status, code, reaction] of [
		[409, 'agent_nicht_aktiv', 'pause'],
		[429, 'agent_budget_erschoepft', 'pauseUntilNextPeriod'],
		[403, 'agent_nicht_gebunden', 'informAdmin'],
		[403, 'kein_agent_run_recht', 'informAdmin'],
		[503, 'agent_status_nicht_pruefbar', 'retryLater'],
	] as const) {
		const s = fakeServer([() => ok({ access_token: 'acct', expires_in: 3600 }), () => err(status, code)]);
		const tokens = new AgentRunTokens(s.post, Date.now, freshStore());
		await assert.rejects(tokens.runToken(ACCOUNT, AGENT, 'exec-1'), (e: unknown) => e instanceof AgentRunError && e.code === code && e.reaction === reaction && e.status === status);
	}
});

test('agent run: bad agent or run id is refused before any call', async () => {
	const s = fakeServer([]);
	const tokens = new AgentRunTokens(s.post, Date.now, freshStore());
	await assert.rejects(tokens.runToken(ACCOUNT, 'not-a-uuid', 'exec-1'), (e: unknown) => e instanceof AgentRunError && e.code === 'agent_uuid_fehlt');
	await assert.rejects(tokens.runToken(ACCOUNT, AGENT, 'exec 1'), (e: unknown) => e instanceof AgentRunError && e.code === 'run_id_ungueltig');
	assert.equal(s.calls.length, 0);
	assert.ok(isValidRunId('n8n:20315') && !isValidRunId('') && !isValidRunId('x'.repeat(129)));
});

test('agent run: client credentials in the body when the credential says so', async () => {
	const s = fakeServer([() => ok({ access_token: 'acct' }), () => ok({ access_token: 'run' })]);
	await new AgentRunTokens(s.post, Date.now, freshStore()).runToken({ ...ACCOUNT, authentication: 'body' }, AGENT, 'exec-1');
	assert.equal(s.calls[0].form.client_secret, 's3cret');
	assert.equal(s.calls[0].headers.Authorization, undefined);
});

test('agent run: refusal codes of the MCP endpoint and unknown codes', () => {
	assert.equal(mcpRefusalCode(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'agent_nicht_aktiv' } })), 'agent_nicht_aktiv');
	assert.equal(mcpRefusalCode(JSON.stringify({ error: 'token_ungueltig' })), 'token_ungueltig');
	assert.equal(reactionFor('neuer_code', 503), 'retryLater');
	assert.equal(reactionFor('neuer_code', 403), 'endRun');
});

const USAGE_URL = 'https://ra.test/api/agent-lauf/verbrauch';

test('usage: reported with the ACCOUNT token to the usage_url of the exchange; one run, its totals', async () => {
	const s = fakeServer([
		() => ok({ access_token: 'acct', expires_in: 3600 }),
		() => ok({ access_token: 'run-1', expires_in: 900, usage_url: USAGE_URL }),
		() => ok({ run_id: 'exec-1', period_year: 2026, period: '2026-11', counted: true, budget_currency: 'USD' }),
	]);
	const urls: string[] = [];
	const post = async (url: string, form: Record<string, string>, headers: Record<string, string>) => { urls.push(url); return s.post(url, form, headers); };
	const tokens = new AgentRunTokens(post, () => 0, freshStore());
	const run = await tokens.runToken(ACCOUNT, AGENT, 'exec-1');
	assert.equal(run.usageUrl, USAGE_URL);
	const r = await tokens.reportUsage(ACCOUNT, { agentUuid: AGENT, runId: 'exec-1', model: 'claude-opus-5-5', inputTokens: 1000, outputTokens: 200, cost: 0.12, currency: 'USD', priceKind: 'tabelle', priceSource: 'runner-tabelle 2026-11-20' }, run.usageUrl);
	assert.deepEqual(r, { runId: 'exec-1', periodYear: 2026, period: '2026-11', counted: true, budgetCurrency: 'USD' });
	assert.equal(urls[2], USAGE_URL);
	assert.equal(s.calls[2].headers.Authorization, 'Bearer acct', 'the account token, not the run token');
	assert.deepEqual(s.calls[2].form, { agent_uuid: AGENT, run_id: 'exec-1', model: 'claude-opus-5-5', input_tokens: '1000', output_tokens: '200', cost: '0.12', currency: 'USD', price_kind: 'tabelle', price_source: 'runner-tabelle 2026-11-20' });
});

test('usage: without a cost only tokens go out; without usage_url the path next to the token endpoint', async () => {
	const s = fakeServer([() => ok({ access_token: 'acct', expires_in: 3600 }), () => ok({ run_id: 'r', period_year: 2026, period: '2026-11', counted: false, budget_currency: 'USD' })]);
	const urls: string[] = [];
	const post = async (url: string, form: Record<string, string>, headers: Record<string, string>) => { urls.push(url); return s.post(url, form, headers); };
	const r = await new AgentRunTokens(post, () => 0, freshStore()).reportUsage(ACCOUNT, { agentUuid: AGENT, runId: 'r', model: 'gpt-x', inputTokens: 10 });
	assert.equal(r.counted, false);
	assert.equal(urls[1], 'https://ra.test/api/agent-lauf/verbrauch');
	assert.deepEqual(s.calls[1].form, { agent_uuid: AGENT, run_id: 'r', model: 'gpt-x', input_tokens: '10' });
});

test('usage: a stale account token is renewed once; other refusals carry their reaction', async () => {
	const s = fakeServer([
		() => ok({ access_token: 'acct-1', expires_in: 3600 }),
		() => err(401, 'secret_widerrufen'),
		() => ok({ access_token: 'acct-2', expires_in: 3600 }),
		() => ok({ run_id: 'r', period_year: 2026, period: '2026-11', counted: true, budget_currency: 'USD' }),
		() => err(409, 'planung_nicht_lizenziert'),
		() => err(503, 'planung_nicht_erreichbar'),
	]);
	const tokens = new AgentRunTokens(s.post, () => 0, freshStore());
	const report = { agentUuid: AGENT, runId: 'r', cost: 1, currency: 'USD', priceKind: 'tabelle' as const };
	assert.equal((await tokens.reportUsage(ACCOUNT, report, USAGE_URL)).counted, true);
	assert.equal(s.calls[3].headers.Authorization, 'Bearer acct-2');
	await assert.rejects(tokens.reportUsage(ACCOUNT, report, USAGE_URL), (e: AgentRunError) => e.code === 'planung_nicht_lizenziert' && e.reaction === 'stopReporting');
	await assert.rejects(tokens.reportUsage(ACCOUNT, report, USAGE_URL), (e: AgentRunError) => e.code === 'planung_nicht_erreichbar' && e.reaction === 'retryLater');
});

test('usage: refused locally before any call — bad agent, bad run ID, cost without currency', async () => {
	const s = fakeServer([]);
	const tokens = new AgentRunTokens(s.post, () => 0, freshStore());
	await assert.rejects(tokens.reportUsage(ACCOUNT, { agentUuid: 'x', runId: 'r' }), (e: AgentRunError) => e.code === 'agent_uuid_fehlt');
	await assert.rejects(tokens.reportUsage(ACCOUNT, { agentUuid: AGENT, runId: 'mit leer' }), (e: AgentRunError) => e.code === 'run_id_ungueltig');
	await assert.rejects(tokens.reportUsage(ACCOUNT, { agentUuid: AGENT, runId: 'r', cost: 1 }), (e: AgentRunError) => e.code === 'meldung_ungueltig' && e.reaction === 'fixConfig');
	assert.equal(s.calls.length, 0);
});
