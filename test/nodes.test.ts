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
	const { ctx, calls } = execCtx({ resource: 'agent', source: 'agentKey', operation: 'getContext', agentUuid: AGENT.toUpperCase(), agentOptions: {} }, keysCreds, () => bundle('active'));
	const [[item]] = await new RoleAlpha().execute.call(ctx);
	assert.equal(calls[0].url, `https://data.example.com/api/agents/${AGENT}/context`);
	assert.equal(calls[0].headers['x-agent-key'], 'agt_secret');
	assert.equal(item.json.agentName, 'Assistant');
	assert.deepEqual(item.json.roleUuids, ['r1']);
});

test('Get Context fails closed for inactive agents and agents without guardrails', async () => {
	const inactive = execCtx({ resource: 'agent', source: 'agentKey', operation: 'getContext', agentUuid: AGENT, agentOptions: {} }, keysCreds, () => bundle('draft'));
	await assert.rejects(new RoleAlpha().execute.call(inactive.ctx), /not active/);
	const bare = execCtx({ resource: 'agent', source: 'agentKey', operation: 'getContext', agentUuid: AGENT, agentOptions: {} }, keysCreds, () => bundle('active', 0));
	await assert.rejects(new RoleAlpha().execute.call(bare.ctx), /no policy/);
	const unknown = execCtx({ resource: 'agent', source: 'agentKey', operation: 'getContext', agentUuid: 'eb2d0919-2cdb-4694-ab5d-e72a97c7b2c7', agentOptions: {} }, keysCreds);
	await assert.rejects(new RoleAlpha().execute.call(unknown.ctx), /No key/);
});

test('List Configured Agents skips inactive agents', async () => {
	const { ctx } = execCtx({ resource: 'agent', source: 'agentKey', operation: 'listAgents', agentOptions: {} }, keysCreds, () => bundle('retired'));
	assert.deepEqual(await new RoleAlpha().execute.call(ctx), [[]]);
});

/** Fake roleALPHA MCP endpoint behind httpRequestWithAuthentication. Tools answer from `tools`. */
function mcpCtx(params: Record<string, unknown>, tools: Record<string, (args: any) => unknown>) {
	const toolCalls: Array<{ name: string; args: any }> = [];
	const credentialTypes: string[] = [];
	const { ctx } = execCtx(params, {});
	ctx.helpers.httpRequestWithAuthentication = async (type: string, opts: any) => {
		credentialTypes.push(type);
		const msg = JSON.parse(opts.body);
		if (msg.id === undefined) return { statusCode: 202, headers: {}, body: '' };
		let result: unknown = {};
		if (msg.method === 'tools/call') {
			toolCalls.push({ name: msg.params.name, args: msg.params.arguments });
			result = { content: [{ type: 'text', text: JSON.stringify(tools[msg.params.name](msg.params.arguments)) }] };
		}
		return { statusCode: 200, headers: { 'mcp-session-id': 's1' }, body: JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) };
	};
	return { ctx, toolCalls, credentialTypes };
}

const mcpParams = { resource: 'agent', endpointUrl: 'https://ra.example.com/api/mcp', organisation: 'org-1', agentOptions: {} };

test('Get Context over MCP reads the agent view without an agent key', async () => {
	const { ctx, toolCalls, credentialTypes } = mcpCtx({ ...mcpParams, operation: 'getContext', agentUuid: AGENT.toUpperCase() }, { get_agent_context: () => bundle('active') });
	const [[item]] = await new RoleAlpha().execute.call(ctx);
	assert.deepEqual(toolCalls, [{ name: 'get_agent_context', args: { agent_uuid: AGENT, organisation: 'org-1', view: 'agent' } }]);
	assert.ok(credentialTypes.every((t) => t === 'mcpOAuth2Api'));
	assert.equal(item.json.agentName, 'Assistant');
	assert.equal(item.json.contextVersion, 'v1');
});

test('Get Context over MCP fails closed like the agent key path', async () => {
	const inactive = mcpCtx({ ...mcpParams, operation: 'getContext', agentUuid: AGENT }, { get_agent_context: () => bundle('paused') });
	await assert.rejects(new RoleAlpha().execute.call(inactive.ctx), /not active/);
	const bare = mcpCtx({ ...mcpParams, operation: 'getContext', agentUuid: AGENT }, { get_agent_context: () => bundle('active', 0) });
	await assert.rejects(new RoleAlpha().execute.call(bare.ctx), /no policy/);
});

test('List Agents over MCP pages through the organisation and keeps only active agents', async () => {
	const OTHER = 'eb2d0919-2cdb-4694-ab5d-e72a97c7b2c7';
	const DRAFT = 'd51abf32-c237-4d60-9536-9ba71d548d56';
	const pages: Record<number, unknown> = {
		0: { agents: [{ uuid: AGENT, name: 'Assistant', customerId: 'x:assistant', summary: 'Assistant | active' }, { uuid: DRAFT, name: 'Draft', summary: 'Draft | draft' }], hasMore: true, nextOffset: 2 },
		2: { agents: [{ uuid: OTHER, name: 'Coach', status: 'active' }], hasMore: false, nextOffset: null },
	};
	const { ctx, toolCalls } = mcpCtx({ ...mcpParams, operation: 'listAgents', agentOptions: { includeContext: false } }, { search_agents: (a) => pages[a.offset] });
	const [items] = await new RoleAlpha().execute.call(ctx);
	assert.deepEqual(items.map((i: any) => i.json.agentUuid), [AGENT, OTHER]);
	assert.equal(items[0].json.customId, 'x:assistant');
	assert.deepEqual(toolCalls.map((c) => c.args.offset), [0, 2]);
});

test('List Agents over MCP drops agents whose context is not active', async () => {
	const { ctx, toolCalls } = mcpCtx({ ...mcpParams, operation: 'listAgents' }, {
		search_agents: () => ({ agents: [{ uuid: AGENT, name: 'Assistant', summary: 'Assistant | active' }], hasMore: false }),
		get_agent_context: () => bundle('retired'),
	});
	assert.deepEqual(await new RoleAlpha().execute.call(ctx), [[]]);
	assert.deepEqual(toolCalls.map((c) => c.name), ['search_agents', 'get_agent_context']);
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
