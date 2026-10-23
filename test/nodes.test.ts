import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoleAlpha } from '../nodes/RoleAlpha/RoleAlpha.node';
import { ApprovalSeal } from '../nodes/ApprovalSeal/ApprovalSeal.node';
import { RoleAlphaTrigger } from '../nodes/RoleAlphaTrigger/RoleAlphaTrigger.node';
import { signBody } from '../lib/webhook';

const AGENT = '48bc018a-18f8-4430-910c-9c1fe9df6bd4';
const KEY = 'k'.repeat(48);

/** Minimal IExecuteFunctions: parameters per name, one input item, recorded HTTP calls. */
function execCtx(params: Record<string, unknown>, creds: Record<string, unknown>, http: (opts: any) => unknown = () => ({})) {
	const calls: any[] = [];
	return {
		calls,
		ctx: {
			getInputData: () => [{ json: { input: true } }],
			getNodeParameter: (name: string, _i: number, fallback?: unknown) => (name in params ? params[name] : fallback),
			getCredentials: async () => creds,
			getNode: () => ({ name: 'test', type: 'test', typeVersion: 1, position: [0, 0], parameters: {} }),
			continueOnFail: () => false,
			helpers: {
				httpRequest: async (opts: any) => {
					calls.push(opts);
					return http(opts);
				},
			},
		} as any,
	};
}

const bundle = (status: string, guardrails = 1) => ({
	bundleVersion: '1',
	contextVersion: 'v1',
	agent: { uuid: AGENT, name: 'Assistant', status },
	guardrails: Array.from({ length: guardrails }, (_, n) => ({ kind: 'policy', uuid: `p${n}`, name: `Policy ${n}` })),
	context: [{ kind: 'role', uuid: 'r1', name: 'Assistant', body: {} }],
});

const keysCreds = { baseUrl: 'https://data.example.com/', keys: JSON.stringify({ [AGENT]: 'agt_secret' }) };

test('Get Context sends the agent key and summarizes the bundle', async () => {
	const { ctx, calls } = execCtx({ resource: 'agent', operation: 'getContext', agentUuid: AGENT.toUpperCase(), agentOptions: {} }, keysCreds, () => bundle('active'));
	const [[item]] = await new RoleAlpha().execute.call(ctx);
	assert.equal(calls[0].url, `https://data.example.com/api/agents/${AGENT}/context`);
	assert.equal(calls[0].headers['x-agent-key'], 'agt_secret');
	assert.equal(item.json.agentName, 'Assistant');
	assert.deepEqual(item.json.roleUuids, ['r1']);
});

test('Get Context fails closed for inactive agents and agents without guardrails', async () => {
	const inactive = execCtx({ resource: 'agent', operation: 'getContext', agentUuid: AGENT, agentOptions: {} }, keysCreds, () => bundle('draft'));
	await assert.rejects(new RoleAlpha().execute.call(inactive.ctx), /not active/);
	const bare = execCtx({ resource: 'agent', operation: 'getContext', agentUuid: AGENT, agentOptions: {} }, keysCreds, () => bundle('active', 0));
	await assert.rejects(new RoleAlpha().execute.call(bare.ctx), /no policy/);
	const unknown = execCtx({ resource: 'agent', operation: 'getContext', agentUuid: 'eb2d0919-2cdb-4694-ab5d-e72a97c7b2c7', agentOptions: {} }, keysCreds);
	await assert.rejects(new RoleAlpha().execute.call(unknown.ctx), /No key/);
});

test('List Configured Agents skips inactive agents', async () => {
	const { ctx } = execCtx({ resource: 'agent', operation: 'listAgents', agentOptions: {} }, keysCreds, () => bundle('retired'));
	assert.deepEqual(await new RoleAlpha().execute.call(ctx), [[]]);
});

test('Build System Prompt accepts the Get Context output', async () => {
	const { ctx } = execCtx({ resource: 'prompt', operation: 'buildSystemPrompt', bundle: { bundle: bundle('active') }, triggerType: 'schedule', extraRules: 'Answer in JSON.' }, {});
	const [[item]] = await new RoleAlpha().execute.call(ctx);
	assert.match(String(item.json.systemPrompt), /# Identity[\s\S]*Answer in JSON\./);
});

test('Approval Seal signs and refuses a changed version', async () => {
	const creds = { key: KEY, legacyKey: '' };
	const base = { type: 'post', fields: '{"text":"Hello"}', approver: 'ada@example.com', options: {} };
	const signed = execCtx({ ...base, operation: 'sign' }, creds);
	const [[s]] = await new ApprovalSeal().execute.call(signed.ctx);
	const seal = String(s.json.approvalSeal);
	const ok = execCtx({ ...base, operation: 'verify', seal }, creds);
	const [[v]] = await new ApprovalSeal().execute.call(ok.ctx);
	assert.equal((v.json.approvalSeal as any).valid, true);
	const changed = execCtx({ ...base, fields: '{"text":"Hello!"}', operation: 'verify', seal }, creds);
	await assert.rejects(new ApprovalSeal().execute.call(changed.ctx), /Changed after approval/);
});

function hookCtx(raw: string, signature: string | undefined, filter = '') {
	const sent: { status?: number; body?: unknown } = {};
	const res = { status: (s: number) => ((sent.status = s), res), json: (b: unknown) => ((sent.body = b), res) };
	return {
		sent,
		ctx: {
			getRequestObject: () => ({ rawBody: Buffer.from(raw) }),
			getResponseObject: () => res,
			getBodyData: () => JSON.parse(raw),
			getHeaderData: () => (signature ? { 'x-ra-signature': signature } : {}),
			getCredentials: async () => ({ secrets: JSON.stringify({ [AGENT]: 'hook-secret' }) }),
			getNodeParameter: () => filter,
			helpers: { returnJsonArray: (a: unknown[]) => a.map((json) => ({ json })) },
		} as any,
	};
}

test('Trigger accepts only correctly signed context events', async () => {
	const raw = JSON.stringify({ event: 'context.changed', agentUuid: AGENT, contextVersion: 'v2', changedAt: '2026-10-23T08:00:00Z' });
	const good = hookCtx(raw, signBody('hook-secret', raw));
	const ok = await new RoleAlphaTrigger().webhook.call(good.ctx);
	assert.equal((ok.workflowData?.[0][0].json as any).contextVersion, 'v2');

	const forged = hookCtx(raw, signBody('wrong', raw));
	assert.deepEqual(await new RoleAlphaTrigger().webhook.call(forged.ctx), { noWebhookResponse: true });
	assert.equal(forged.sent.status, 401);

	const unsigned = hookCtx(raw, undefined);
	await new RoleAlphaTrigger().webhook.call(unsigned.ctx);
	assert.equal(unsigned.sent.status, 401);

	const filtered = hookCtx(raw, signBody('hook-secret', raw), 'eb2d0919-2cdb-4694-ab5d-e72a97c7b2c7');
	await new RoleAlphaTrigger().webhook.call(filtered.ctx);
	assert.equal(filtered.sent.status, 202);
});

test('node descriptions use generic English names', () => {
	assert.equal(new RoleAlpha().description.name, 'roleAlpha');
	assert.equal(new ApprovalSeal().description.name, 'approvalSeal');
	assert.equal(new RoleAlphaTrigger().description.name, 'roleAlphaTrigger');
});
