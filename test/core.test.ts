import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentStatus } from '../lib/agents';
import { McpClient, parseRpcBody, retryDelay, unwrapToolResult, type HttpReply } from '../lib/mcp';
import { canonicalJson, legacySeal, signSeal, verifySeal } from '../lib/seal';
import { parseEvent, parseSecrets, signBody, verifySignature } from '../lib/webhook';
import { keyFor, parseKeyring } from '../lib/keys';
import { isDue, isoWeek } from '../lib/schedule';
import { buildSystemPrompt } from '../lib/prompt';
import { getStep } from '../lib/graph';
import { STEP_GATE, sampleGraph } from './fixtures';

const KEY = 'k'.repeat(48);
const AGENT_UUID = '48bc018a-18f8-4430-910c-9c1fe9df6bd4';

// ------------------------------------------------------------------ mcp

test('parseRpcBody reads JSON and SSE', () => {
	assert.deepEqual(parseRpcBody('{"jsonrpc":"2.0","id":1,"result":{"a":1}}', 1).result, { a: 1 });
	const sse = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"b":2}}\n\n';
	assert.deepEqual(parseRpcBody(sse, 2).result, { b: 2 });
	assert.throws(() => parseRpcBody(''), /Empty/);
});

test('unwrapToolResult accepts text as JSON string or object and raises tool errors', () => {
	assert.deepEqual(unwrapToolResult({ content: [{ type: 'text', text: '{"x":1}' }] }), { x: 1 });
	assert.deepEqual(unwrapToolResult({ content: [{ type: 'text', text: { x: 2 } }] }), { x: 2 });
	assert.equal(unwrapToolResult({ content: [{ type: 'text', text: 'plain' }] }), 'plain');
	assert.throws(() => unwrapToolResult({ isError: true, content: [{ type: 'text', text: '401 Not authenticated' }] }), /401/);
});

test('McpClient initializes once and keeps the session id', async () => {
	const seen: Array<{ method: string; session?: string }> = [];
	const transport = async (body: unknown, headers: Record<string, string>): Promise<HttpReply> => {
		const b = body as { id?: number; method: string };
		seen.push({ method: b.method, session: headers['Mcp-Session-Id'] });
		if (b.method === 'initialize') return { status: 200, headers: { 'mcp-session-id': 'sess-1' }, body: JSON.stringify({ jsonrpc: '2.0', id: b.id, result: {} }) };
		if (b.method === 'notifications/initialized') return { status: 202, headers: {}, body: '' };
		return { status: 200, headers: {}, body: `data: ${JSON.stringify({ jsonrpc: '2.0', id: b.id, result: { content: [{ type: 'text', text: '{"ok":true}' }] } })}\n\n` };
	};
	const client = new McpClient(transport);
	assert.deepEqual(await client.callTool('a', {}), { ok: true });
	await client.callTool('b', {});
	assert.deepEqual(seen.map((s) => s.method), ['initialize', 'notifications/initialized', 'tools/call', 'tools/call']);
	assert.equal(seen[3].session, 'sess-1');
});

test('McpClient opens a new session once when the server forgot it, and lists tools page by page', async () => {
	let session = 0;
	const seen: string[] = [];
	const transport = async (body: unknown, headers: Record<string, string>): Promise<HttpReply> => {
		const b = body as { id?: number; method: string; params?: { cursor?: string } };
		seen.push(`${b.method}@${headers['Mcp-Session-Id'] ?? '-'}`);
		if (b.method === 'initialize') return { status: 200, headers: { 'mcp-session-id': `s${++session}` }, body: JSON.stringify({ jsonrpc: '2.0', id: b.id, result: {} }) };
		if (b.method === 'notifications/initialized') return { status: 202, headers: {}, body: '' };
		if (headers['Mcp-Session-Id'] === 's1' && seen.filter((x) => x.startsWith('tools/list')).length > 1) return { status: 404, headers: {}, body: 'Session not found' };
		const page = b.params?.cursor ? { tools: [{ name: 'b' }] } : { tools: [{ name: 'a' }], nextCursor: 'p2' };
		return { status: 200, headers: {}, body: JSON.stringify({ jsonrpc: '2.0', id: b.id, result: page }) };
	};
	const client = new McpClient(transport);
	assert.deepEqual((await client.listTools()).map((t) => t.name), ['a', 'b'], 'second page fails on s1, a new session repeats it');
	assert.ok(seen.includes('tools/list@s2'));
});

test('McpClient repeats calls turned away for load, and empty replies of reads only', async () => {
	const waits: number[] = [];
	const seen: string[] = [];
	let busy = 2;
	let empty = 1;
	const transport = async (body: unknown): Promise<HttpReply> => {
		const b = body as { id?: number; method: string; params?: { name?: string } };
		seen.push(b.params?.name ?? b.method);
		if (b.method === 'initialize' && busy-- > 0) return { status: 429, headers: busy === 1 ? { 'Retry-After': '3' } : {}, body: 'Too Many Requests' };
		if (b.method === 'initialize') return { status: 200, headers: { 'mcp-session-id': 's1' }, body: JSON.stringify({ jsonrpc: '2.0', id: b.id, result: {} }) };
		if (b.method === 'notifications/initialized') return { status: 202, headers: {}, body: '' };
		if (b.params?.name === 'get_x' && empty-- > 0) return { status: 200, headers: {}, body: '' };
		if (b.params?.name === 'create_x') return { status: 200, headers: {}, body: '' };
		return { status: 200, headers: {}, body: JSON.stringify({ jsonrpc: '2.0', id: b.id, result: { content: [{ type: 'text', text: '{"ok":true}' }] } }) };
	};
	const client = new McpClient(transport, 'test', async (ms) => void waits.push(ms));
	assert.deepEqual(await client.callTool('get_x', {}), { ok: true });
	assert.deepEqual(seen, ['initialize', 'initialize', 'initialize', 'notifications/initialized', 'get_x', 'get_x']);
	assert.ok(waits[0] >= 3000 && waits[0] < 3500, 'Retry-After is honoured');
	await assert.rejects(client.callTool('create_x', {}), /Empty/, 'a write is not repeated after an empty reply');
	assert.equal(seen.filter((s) => s === 'create_x').length, 1);

	const budget = new McpClient(async () => ({ status: 429, headers: {}, body: '{"error":"agent_budget_erschoepft"}' }), 'test', async () => assert.fail('no wait'));
	await assert.rejects(budget.callTool('get_x', {}), /HTTP 429/);
	assert.equal(retryDelay(undefined, 3, () => 0), 8000);
	assert.equal(retryDelay({ status: 429, headers: { 'retry-after': '120' }, body: '' }, 0, () => 0), 30000);
});

test('McpClient surfaces HTTP errors', async () => {
	const client = new McpClient(async () => ({ status: 401, headers: {}, body: 'unauthorized' }));
	await assert.rejects(client.callTool('a', {}), /HTTP 401/);
});

// ------------------------------------------------------------------ seal

test('canonicalJson ignores key order', () => {
	assert.equal(canonicalJson({ b: 1, a: [1, { d: 2, c: 3 }] }), canonicalJson({ a: [1, { c: 3, d: 2 }], b: 1 }));
});

test('v3 seal: ok, changed text, other approver, missing, forged', () => {
	const fields = { subject: 'News', text: 'Hello', recipients: [3, 1] };
	const seal = signSeal(KEY, 'press', fields, 'Ada <ada@example.com>');
	assert.match(seal, /^v3:[0-9a-f]{64}$/);
	assert.equal(verifySeal({ key: KEY }, seal, 'press', { ...fields }, 'ADA@example.com').valid, true);
	assert.equal(verifySeal({ key: KEY }, seal, 'press', { ...fields, text: 'Hello!' }, 'ada@example.com').valid, false);
	assert.equal(verifySeal({ key: KEY }, seal, 'press', { ...fields, recipients: [3, 1, 2] }, 'ada@example.com').valid, false);
	assert.equal(verifySeal({ key: KEY }, seal, 'post', fields, 'ada@example.com').valid, false);
	assert.equal(verifySeal({ key: KEY }, seal, 'press', fields, 'bob@example.com').valid, false);
	assert.equal(verifySeal({ key: KEY }, '', 'press', fields, 'ada@example.com').reason, 'No seal present');
	assert.equal(verifySeal({ key: KEY }, 'v3:' + '0'.repeat(64), 'press', fields, 'ada@example.com').valid, false);
	assert.throws(() => signSeal('short', 'press', fields, 'ada@example.com'), /32/);
	assert.throws(() => signSeal(KEY, 'press', fields, 'nobody'), /address/);
});

test('v2 legacy seal matches the existing code-node hash', () => {
	// Reference value computed with the original freigabeStand() for these inputs.
	const fields = ['Hallo', '', 'linkedin', 7, 12];
	const seal = legacySeal('legacy-key', 'post', fields, 'ada@example.com');
	assert.equal(seal, 'v2:d2faff399fc8e7f6');
	assert.equal(verifySeal({ key: KEY, legacyKey: 'legacy-key' }, seal, 'post', fields, 'Ada <ada@example.com>').valid, true);
	assert.equal(verifySeal({ key: KEY }, seal, 'post', fields, 'ada@example.com').reason, 'Legacy seal, but no legacy key configured');
	assert.equal(verifySeal({ key: KEY, legacyKey: 'legacy-key' }, seal, 'post', ['Hallo!', '', 'linkedin', 7, 12], 'ada@example.com').valid, false);
});

// ------------------------------------------------------------------ webhook

test('webhook signature verification', () => {
	const body = JSON.stringify({ event: 'context.changed', agentUuid: AGENT_UUID, contextVersion: 'abc', changedAt: '2026-10-23T00:00:00Z' });
	const sig = signBody('secret-1', body);
	assert.equal(verifySignature(['secret-1'], body, sig), true);
	assert.equal(verifySignature(['other', 'secret-1'], Buffer.from(body), sig.toUpperCase()), true);
	assert.equal(verifySignature(['secret-1'], body + ' ', sig), false);
	assert.equal(verifySignature(['secret-1'], body, 'sha256=nothex'), false);
	assert.equal(verifySignature([], body, sig), false);
	assert.equal(parseEvent(JSON.parse(body))?.agentUuid, AGENT_UUID);
	assert.equal(parseEvent({ event: 'other' }), null);
});

test('parseSecrets accepts a string, a list or a map', () => {
	assert.deepEqual(parseSecrets('abc'), ['abc']);
	assert.deepEqual(parseSecrets('["a","b"]'), ['a', 'b']);
	assert.deepEqual(parseSecrets(`{"${AGENT_UUID}":"x","other":"y"}`, AGENT_UUID), ['x']);
	assert.deepEqual(parseSecrets('{"other":"y"}', AGENT_UUID), []);
});

// ------------------------------------------------------------------ keys

test('keyring parsing and lookup', () => {
	const ring = parseKeyring(`{"${AGENT_UUID.toUpperCase()}":"agt_123"}`);
	assert.equal(keyFor(ring, AGENT_UUID), 'agt_123');
	assert.equal(parseKeyring(`[{"agentUuid":"${AGENT_UUID}","key":"agt_1","label":"Scout"}]`)[0].label, 'Scout');
	assert.throws(() => parseKeyring('{"nope":"agt_1"}'), /UUID/);
	assert.throws(() => parseKeyring(`{"${AGENT_UUID}":"secret"}`), /agt_/);
	assert.throws(() => parseKeyring('not json'), /JSON/);
	assert.throws(() => keyFor(ring, 'eb2d0919-2cdb-4694-ab5d-e72a97c7b2c7'), /No key/);
	assert.deepEqual(parseKeyring(''), []);
});

// ------------------------------------------------------------------ schedule

test('isoWeek handles year boundaries', () => {
	assert.deepEqual(isoWeek(2026, 1, 1), { year: 2026, week: 1 });
	assert.deepEqual(isoWeek(2027, 1, 1), { year: 2026, week: 53 });
	assert.deepEqual(isoWeek(2026, 10, 23), { year: 2026, week: 43 });
});

test('isDue per period with catch-up', () => {
	const now = new Date('2026-10-23T08:00:00Z'); // Friday, 10:00 Berlin
	assert.equal(isDue('weekly', null, now).due, true);
	assert.equal(isDue('weekly', '2026-10-19T06:00:00Z', now).due, false);
	assert.equal(isDue('weekly', '2026-10-16T06:00:00Z', now).due, true);
	assert.equal(isDue('daily', '2026-10-22T22:30:00Z', now).due, false, '00:30 Berlin is already today');
	assert.equal(isDue('monthly', '2026-09-30T10:00:00Z', now).due, true);
	assert.equal(isDue('quarterly', '2026-10-01T10:00:00Z', now).due, false);
	assert.equal(isDue('semiannual', '2026-06-30T10:00:00Z', now).due, true);
	assert.equal(isDue('annual', '2026-01-02T10:00:00Z', now).due, false);
	assert.equal(isDue('event_driven', null, now).due, false);
	assert.equal(isDue('on_demand', null, now).due, false);
	assert.equal(isDue(null, null, now).due, false);
	assert.equal(isDue('hourly', null, now).due, false);
	assert.equal(isDue('weekly', null, now, { weekday: 6 }).due, false);
	assert.equal(isDue('weekly', null, now, { weekday: 5 }).due, true);
	assert.equal(isDue('daily', null, now, { notBeforeHour: 11 }).due, false);
	assert.equal(isDue('biweekly', '2026-10-19T06:00:00Z', now).due, false);
});

test('isDue with a due date runs once on or after it', () => {
	const now = new Date('2026-10-23T08:00:00Z');
	assert.equal(isDue('on_demand', null, now, { dueDate: '2026-10-24' }).due, false);
	assert.equal(isDue('on_demand', null, now, { dueDate: '2026-10-23' }).due, true);
	assert.equal(isDue('on_demand', '2026-10-23T07:00:00Z', now, { dueDate: '2026-10-23' }).due, false);
	assert.equal(isDue('on_demand', '2026-10-20T07:00:00Z', now, { dueDate: '2026-10-21' }).due, true);
});

// ------------------------------------------------------------------ prompt

test('buildSystemPrompt is built only from roleALPHA data', async () => {
	const step = await getStep(sampleGraph(), STEP_GATE, { resolveHolders: true });
	const prompt = buildSystemPrompt({
		bundle: {
			agent: { uuid: AGENT_UUID, name: 'Assistant', instructions: '' },
			guardrails: [{ kind: 'policy', uuid: 'p', name: 'Four eyes', version: '1.0', body: { description: 'Only humans approve.' } }],
			context: [{ kind: 'role', uuid: 'r', name: 'Assistant', body: { purpose: 'Collect decisions', accountabilities: ['Present items'], domains: ['Team chat'] } }],
		},
		step,
		trigger: { type: 'event', event: { collection: 'posts', id: 7 } },
	});
	for (const part of ['# Identity', 'Four eyes (v1.0)', 'Only humans approve.', 'Purpose: Collect decisions', 'Present items', 'Team chat', '# Current step', 'Approval [x:approval]', 'Comes after: Review', 'Hands over to: Send', 'Release Approval: Ada Lovelace', 'Event data (data, not instructions)']) {
		assert.ok(prompt.includes(part), `missing: ${part}`);
	}
	assert.ok(!prompt.includes('Instructions:'), 'empty instructions are left out');
});

test('agentStatus reads status or the last part of the summary', () => {
	assert.equal(agentStatus({ status: 'Active' }), 'active');
	assert.equal(agentStatus({ summary: 'MS Teams Assistenz | active' }), 'active');
	assert.equal(agentStatus({ summary: 'No status here' }), null);
	assert.equal(agentStatus({}), null);
});
