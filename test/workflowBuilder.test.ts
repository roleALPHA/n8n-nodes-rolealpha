import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectChanges, readSnapshots, snapshotOf, toRow, type EntityChange } from '../lib/changes';
import {
	applyDraft,
	checkPlan,
	contentHash,
	DEFAULT_NODE_TYPES,
	discardDraft,
	draftHash,
	draftWorkflow,
	markerNode,
	N8nApi,
	readBinding,
	summarizeWorkflows,
	type N8nWorkflow,
	type PlanContext,
} from '../lib/workflows';
import { RoleAlphaWorkflowBuilder } from '../nodes/RoleAlphaWorkflowBuilder/RoleAlphaWorkflowBuilder.node';
import { FakeGraph } from './fixtures';
import { issueToken, TOKEN_PATTERN, verifyToken } from '../lib/approvalToken';
import { signSeal } from '../lib/seal';

const STEP = 's2000000-0000-4000-8000-000000000001';
const ROLE = 'r2000000-0000-4000-8000-000000000001';
const AGENT = 'a2000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-11-02T08:00:00Z');
const SEAL_KEY = 'k'.repeat(16) + '0123456789abcdef0123';

const snap = (uuid: string, name: string, data: Record<string, unknown> = {}, edges: Array<[string, 'incoming' | 'outgoing', string]> = [], entityType = 'process') =>
	snapshotOf({ uuid, name, entityType }, { name, customId: null, data }, edges.map(([type, direction, to]) => ({ type, direction, uuid: to, name: '', entityType: '' })));

// ---------------------------------------------------------------- detection

test('The first run stores the snapshot and reports nothing', () => {
	const res = detectChanges([], [snap(STEP, 'Review')], { complete: true, types: ['process'], now: NOW });
	assert.equal(res.baseline, true);
	assert.deepEqual(res.changes, []);
	assert.equal(res.upsert.length, 1);
	const reported = detectChanges([], [snap(STEP, 'Review')], { complete: true, types: ['process'], reportBaseline: true });
	assert.equal(reported.changes[0].change, 'created');
});

test('Created, changed and removed entities are reported with what changed', () => {
	const OLD = 's2000000-0000-4000-8000-000000000009';
	const previous = [toRow(snap(STEP, 'Review', { status: 'active', description: 'a' }, [['RESPONSIBLE_FOR', 'incoming', ROLE]]), 'x'), toRow(snap(OLD, 'Gone'), 'x')];
	const NEW = 's2000000-0000-4000-8000-000000000002';
	const current = [snap(STEP, 'Review 2', { status: 'active', description: 'b' }, [['RESPONSIBLE_FOR', 'incoming', AGENT]]), snap(NEW, 'Publish')];
	const res = detectChanges(previous, current, { complete: true, types: ['process'], now: NOW });
	const by = Object.fromEntries(res.changes.map((c) => [c.uuid, c]));
	assert.equal(by[NEW].change, 'created');
	assert.equal(by[STEP].change, 'changed');
	assert.equal(by[STEP].previousName, 'Review');
	assert.deepEqual(by[STEP].changedFields, ['name', 'description']);
	assert.deepEqual(by[STEP].edgesAdded, [`RESPONSIBLE_FOR<${AGENT}`]);
	assert.deepEqual(by[STEP].edgesRemoved, [`RESPONSIBLE_FOR<${ROLE}`]);
	assert.equal(by[OLD].change, 'removed');
	assert.deepEqual(res.remove, [OLD]);
	assert.equal(res.upsert.length, 2);
});

test('An unchanged entity and volatile attributes report nothing', () => {
	const previous = [toRow(snap(STEP, 'Review', { status: 'active', updatedAt: '1' }), 'x')];
	const res = detectChanges(previous, [snap(STEP, 'Review', { status: 'active', updatedAt: '2' })], { complete: true, types: ['process'] });
	assert.deepEqual(res.changes, []);
	assert.deepEqual(res.upsert, []);
});

test('An unreadable entity is neither changed nor removed, and rows of other types stay', async () => {
	const graph = new FakeGraph({ [STEP]: { name: 'Review', type: 'Value Creation' } }, [], new Set([STEP]));
	const read = await readSnapshots(graph, [{ uuid: STEP, name: 'Review', entityType: 'process' }]);
	assert.equal(read.unreadable.length, 1);
	const previous = [toRow(snap(STEP, 'Review'), 'x'), toRow(snap(ROLE, 'Copy', {}, [], 'role'), 'x')];
	const res = detectChanges(previous, read.snapshots, { complete: true, types: ['process'], unreadable: read.unreadable });
	assert.deepEqual(res.changes, []);
	assert.deepEqual(res.remove, []);
	const partial = detectChanges(previous, [], { complete: false, types: ['process', 'role'] });
	assert.deepEqual(partial.remove, [], 'without the complete index nothing counts as removed');
});

// ---------------------------------------------------------------- the check

const change: EntityChange = { change: 'created', uuid: STEP, name: 'Publish', entityType: 'process', customId: 'mk:publish', previousName: null, changedFields: [], edgesAdded: [], edgesRemoved: [] };

const managedWf = (id: string, extra: Partial<N8nWorkflow> = {}): N8nWorkflow => ({
	id,
	name: 'Event router',
	active: true,
	versionId: 'v1',
	nodes: [
		{ id: 'n1', name: 'Hook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], parameters: { path: 'router' }, webhookId: 'hook-1' },
		{ id: 'n2', name: 'Store', type: 'n8n-nodes-base.dataTable', typeVersion: 1, position: [240, 0], parameters: {}, credentials: { n8nApi: { id: 'c1', name: 'Main' } } },
		markerNode({ managed: true, entities: [ROLE] }),
	],
	connections: { Hook: { main: [[{ node: 'Store', type: 'main', index: 0 }]] } },
	settings: { executionOrder: 'v1' },
	...extra,
});

const planCtx = (workflows: N8nWorkflow[] = [managedWf('w1')]): PlanContext => {
	const m = summarizeWorkflows(workflows);
	return { change, entity: null, workflows: m.workflows, credentials: m.credentials, nodeTypes: DEFAULT_NODE_TYPES };
};

const newWorkflow = (nodes: unknown[], connections: unknown = {}) => ({ action: 'create', reason: 'New step needs a schedule', targetWorkflowId: null, workflow: { name: 'Publish schedule', nodes, connections } });
const schedule = { name: 'Every hour', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, parameters: { rule: { interval: [{ field: 'hours' }] } } };
const runner = { name: 'Run step', type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1.2, parameters: { stepCustomId: 'mk:publish' } };

test('A clean proposal passes and gets IDs, positions and a hash', () => {
	const res = checkPlan(planCtx(), JSON.stringify(newWorkflow([schedule, runner], { 'Every hour': { main: [[{ node: 'Run step', type: 'main', index: 0 }]] } })));
	assert.equal(res.ok, true, res.problems.join('; '));
	assert.equal(res.workflow?.nodes.length, 2);
	assert.ok(res.workflow?.nodes.every((n) => n.id && n.position.length === 2));
	assert.equal(res.contentHash, contentHash(res.workflow!));
	assert.equal(checkPlan(planCtx(), { output: newWorkflow([schedule]) }).ok, true, 'structured parser output is accepted');
	assert.equal(checkPlan(planCtx(), '```json\n' + JSON.stringify({ action: 'none', reason: 'runner covers it', targetWorkflowId: null, workflow: null }) + '\n```').action, 'none');
});

test('The check refuses foreign node types, hard-coded people and UUIDs, and loose connections', () => {
	const code = checkPlan(planCtx(), newWorkflow([{ name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2, parameters: {} }]));
	assert.match(code.problems.join(), /not allowed/);
	const mail = checkPlan(planCtx(), newWorkflow([{ ...runner, parameters: { to: 'Approver <anna@example.com>' } }]));
	assert.match(mail.problems.join(), /e-mail address/);
	const uuid = checkPlan(planCtx(), newWorkflow([{ ...runner, parameters: { role: { value: '9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f' } } }]));
	assert.match(uuid.problems.join(), /contains a UUID/);
	const loose = checkPlan(planCtx(), newWorkflow([schedule], { 'Every hour': { main: [[{ node: 'Nowhere', type: 'main', index: 0 }]] } }));
	assert.match(loose.problems.join(), /no node/);
	assert.equal(loose.workflow, null);
});

test('Only managed workflows can be updated or deactivated', () => {
	const ctx = planCtx();
	assert.match(checkPlan(ctx, { action: 'deactivate', reason: 'x', targetWorkflowId: 'foreign', workflow: null }).problems.join(), /not a managed workflow/);
	const ok = checkPlan(ctx, { action: 'deactivate', reason: 'Step removed', targetWorkflowId: 'w1', workflow: null });
	assert.equal(ok.ok, true);
	assert.equal(ok.targetVersion, 'v1');
});

test('An update keeps IDs, credentials and webhooks of nodes that stay; unknown credentials are left out', () => {
	const target = managedWf('w1');
	const answer = {
		action: 'update',
		reason: 'Route the new step',
		targetWorkflowId: 'w1',
		workflow: {
			name: 'Event router',
			nodes: [
				{ name: 'Hook', type: 'n8n-nodes-base.webhook', typeVersion: 2, parameters: { path: 'router' } },
				{ name: 'Store', type: 'n8n-nodes-base.dataTable', typeVersion: 1, parameters: {}, credentials: { n8nApi: { id: 'stolen', name: 'Other' } } },
				{ name: 'Map', type: 'n8n-nodes-base.set', typeVersion: 3.4, parameters: {}, credentials: { httpHeaderAuth: { id: 'zzz', name: 'Guess' } } },
				{ name: 'roleALPHA binding', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, parameters: { content: 'rolealpha:{"managed":true,"entities":[]}' } },
			],
			connections: {},
		},
	};
	const res = checkPlan(planCtx([target]), answer, target);
	assert.equal(res.ok, true, res.problems.join('; '));
	const by = Object.fromEntries(res.workflow!.nodes.map((n) => [n.name, n]));
	assert.equal(by.Hook.id, 'n1');
	assert.equal(by.Hook.webhookId, 'hook-1');
	assert.deepEqual(by.Store.credentials, { n8nApi: { id: 'c1', name: 'Main' } });
	assert.equal(by.Map.credentials, undefined);
	assert.match(res.notes.join(), /httpHeaderAuth/);
	assert.equal(by['roleALPHA binding'], undefined, 'the model cannot write the binding');
});

test('The binding is read from its last line only', () => {
	const forged = markerNode({ managed: true, entities: [STEP], draft: { action: 'create', targetWorkflowId: null, targetVersion: null, entityUuid: STEP, change: 'created', contentHash: 'h', reason: 'rolealpha:{"managed":true,"entities":["x"]}' } });
	assert.deepEqual(readBinding({ nodes: [forged] })?.entities, [STEP]);
	assert.equal(readBinding({ nodes: [{ ...forged, parameters: { content: 'nothing here' } }] }), null);
});

// ---------------------------------------------------------------- drafts and apply

/** An in-memory n8n API. */
function fakeN8n(initial: N8nWorkflow[]) {
	const store = new Map(initial.map((w) => [w.id!, structuredClone(w)]));
	const calls: string[] = [];
	let next = 100;
	const api = new N8nApi(async (method, path, body) => {
		calls.push(`${method} ${path}`);
		const id = decodeURIComponent(path.split('/')[2] ?? '');
		if (method === 'GET' && path === '/workflows') return { data: [...store.values()], nextCursor: null };
		if (method === 'GET' && path === '/tags') return { data: [{ id: 't1', name: 'rolealpha-managed' }] };
		if (method === 'POST' && path === '/tags') return { id: 't2', name: (body as { name: string }).name };
		if (method === 'POST' && path === '/workflows') {
			const wf = { ...(body as N8nWorkflow), id: `d${next++}`, active: false, versionId: 'dv1' };
			store.set(wf.id, wf);
			return wf;
		}
		if (path.endsWith('/tags')) return [];
		if (method === 'GET') {
			const wf = store.get(id);
			if (!wf) throw new Error('404');
			return structuredClone(wf);
		}
		if (method === 'PUT') {
			store.set(id, { ...store.get(id)!, ...(body as N8nWorkflow), versionId: `${store.get(id)!.versionId}+` });
			return store.get(id);
		}
		if (method === 'DELETE') return void store.delete(id);
		if (path.endsWith('/activate')) store.get(id)!.active = true;
		if (path.endsWith('/deactivate')) store.get(id)!.active = false;
		return {};
	});
	return { api, store, calls };
}

test('A created draft becomes the workflow only with the approved hash', async () => {
	const { api, store } = fakeN8n([managedWf('w1')]);
	const plan = checkPlan(planCtx(), newWorkflow([schedule, runner]));
	const draft = await api.create(draftWorkflow(plan, change));
	assert.ok(draft.name.startsWith('Draft: '));
	const { hash } = draftHash(draft);
	assert.equal(hash, plan.contentHash);
	await assert.rejects(applyDraft(api, draft.id!, 'wrong'), /changed after/);
	// Somebody edits the draft after approval: the hash no longer matches.
	const edited = store.get(draft.id!)!;
	edited.nodes[0].parameters = { rule: { interval: [{ field: 'minutes' }] } };
	await assert.rejects(applyDraft(api, draft.id!, hash), /changed after/);
	edited.nodes[0].parameters = schedule.parameters;
	const res = await applyDraft(api, draft.id!, hash, { activate: true });
	assert.deepEqual([res.action, res.workflowId, res.activated], ['create', draft.id, true]);
	const live = store.get(draft.id!)!;
	assert.equal(live.name, 'Publish schedule');
	assert.equal(readBinding(live)?.draft, undefined);
	assert.deepEqual(readBinding(live)?.entities, [STEP]);
});

test('An update applies onto the target and refuses a target that moved on', async () => {
	const { api, store } = fakeN8n([managedWf('w1')]);
	const target = await api.get('w1');
	const answer = { action: 'update', reason: 'Route it', targetWorkflowId: 'w1', workflow: { name: 'Event router', nodes: [...target.nodes.slice(0, 2), { name: 'Map', type: 'n8n-nodes-base.set', typeVersion: 3.4, parameters: {} }], connections: {} } };
	const plan = checkPlan(planCtx([target]), answer, target);
	const draft = await api.create(draftWorkflow(plan, change, target));
	const { hash } = draftHash(draft);
	store.get('w1')!.versionId = 'v2';
	await assert.rejects(applyDraft(api, draft.id!, hash), /changed after the draft/);
	store.get('w1')!.versionId = 'v1';
	const res = await applyDraft(api, draft.id!, hash);
	assert.equal(res.action, 'update');
	assert.equal(store.has(draft.id!), false, 'the draft is removed');
	const live = store.get('w1')!;
	assert.deepEqual(live.nodes.map((n) => n.name).sort(), ['Hook', 'Map', 'Store', 'roleALPHA binding']);
	assert.deepEqual(readBinding(live)?.entities, [ROLE, STEP]);
});

test('A deactivation draft deactivates the target; discard refuses anything but a draft', async () => {
	const { api, store } = fakeN8n([managedWf('w1')]);
	const plan = checkPlan(planCtx(), { action: 'deactivate', reason: 'Step removed', targetWorkflowId: 'w1', workflow: null });
	const draft = await api.create(draftWorkflow(plan, { ...change, change: 'removed' }, await api.get('w1')));
	const res = await applyDraft(api, draft.id!, draftHash(draft).hash);
	assert.equal(res.action, 'deactivate');
	assert.equal(store.get('w1')!.active, false);
	await assert.rejects(discardDraft(api, 'w1'), /no roleALPHA draft/);
	assert.equal(store.has('w1'), true);
});

// ---------------------------------------------------------------- node

function nodeCtx(params: Record<string, unknown>, opts: { tools?: Record<string, (args: any) => unknown>; n8n?: ReturnType<typeof fakeN8n>; answers?: string[] }) {
	const prompts: unknown[] = [];
	const ctx: any = {
		getInputData: () => [{ json: {} }],
		getNodeParameter: (name: string, _i: number, fallback?: unknown) => (name in params ? params[name] : fallback),
		getCredentials: async (type: string) => (type === 'n8nApi' ? { baseUrl: 'https://n8n.example.com/api/v1/', apiKey: 'k' } : type === 'approvalSealApi' ? { key: SEAL_KEY } : {}),
		getNode: () => ({ name: 'test', type: 'test', typeVersion: 1, position: [0, 0], parameters: {} }),
		continueOnFail: () => false,
		getInputConnectionData: async () => ({
			invoke: async (messages: unknown) => {
				prompts.push(structuredClone(messages));
				return { content: opts.answers?.shift() ?? '{}' };
			},
		}),
		helpers: {
			httpRequestWithAuthentication: async (type: string, req: any) => {
				if (type === 'n8nApi') {
					assert.ok(req.url.startsWith('https://n8n.example.com/api/v1/'));
					return (opts.n8n as any).api.request(req.method, req.url.slice('https://n8n.example.com/api/v1'.length), req.body, req.qs);
				}
				const msg = JSON.parse(req.body);
				if (msg.id === undefined) return { statusCode: 202, headers: {}, body: '' };
				const result = msg.method === 'tools/call' ? { content: [{ type: 'text', text: JSON.stringify(opts.tools![msg.params.name](msg.params.arguments)) }] } : {};
				return { statusCode: 200, headers: { 'mcp-session-id': 's1' }, body: JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) };
			},
		},
	};
	return { ctx, prompts };
}

const graphTools = {
	list_entities: (a: any) => ({ entities: a.entityType === 'process' ? [{ uuid: STEP, name: 'Publish', entityType: 'process' }] : [], hasMore: false }),
	get_entity_details: (a: any) => ({ uuid: a.entityUuid, name: 'Publish', customerId: 'mk:publish', entityTypeName: 'Value Creation', descJsonb: { status: 'active' } }),
	get_entity_relationships: () => ({ relationships: [{ relationType: 'RESPONSIBLE_FOR', direction: 'incoming', connectedEntityUuid: ROLE, connectedEntityName: 'Copy', connectedEntityType: 'Roles' }] }),
};

test('Detect Changes reads the index and reports a new step against stored rows', async () => {
	const stored = [toRow(snap(ROLE, 'Copy', {}, [], 'process'), 'x')];
	const { ctx } = nodeCtx({ operation: 'detectChanges', endpointUrl: 'https://ra/mcp', organisation: 'org', entityTypes: ['process', 'role'], snapshotRows: JSON.stringify(stored), detectOptions: {} }, { tools: graphTools });
	const [[item]] = await new RoleAlphaWorkflowBuilder().execute.call(ctx);
	const res = item.json as any;
	assert.equal(res.baseline, false);
	assert.deepEqual(res.changes.map((c: any) => [c.change, c.uuid]), [['created', STEP], ['removed', ROLE]]);
});

test('Propose asks the model again with the problems, then returns a checked proposal; Create Draft stores it', async () => {
	const n8n = fakeN8n([managedWf('w1')]);
	const bad = JSON.stringify(newWorkflow([{ ...runner, parameters: { to: 'anna@example.com' } }]));
	const good = JSON.stringify(newWorkflow([schedule, runner], { 'Every hour': { main: [[{ node: 'Run step', type: 'main', index: 0 }]] } }));
	const { ctx, prompts } = nodeCtx({ operation: 'propose', endpointUrl: 'https://ra/mcp', organisation: 'org', change, maxAttempts: 2 }, { tools: graphTools, n8n, answers: [bad, good] });
	const [[item]] = await new RoleAlphaWorkflowBuilder().execute.call(ctx);
	const proposal = item.json as any;
	assert.equal(proposal.ok, true, proposal.problems.join('; '));
	assert.equal(proposal.attempts, 2);
	const retry = (prompts[1] as Array<[string, string]>).at(-1)![1];
	assert.match(retry, /e-mail address/);
	assert.match((prompts[0] as Array<[string, string]>)[1][1], /"customId": "mk:publish"/);
	assert.doesNotMatch((prompts[0] as Array<[string, string]>)[1][1], /holders/);

	const draftCtx = nodeCtx({ operation: 'createDraft', proposal }, { n8n });
	const [[draft]] = await new RoleAlphaWorkflowBuilder().execute.call(draftCtx.ctx);
	assert.equal(draft.json.contentHash, proposal.contentHash);
	assert.ok(n8n.calls.includes(`PUT /workflows/${draft.json.draftId}/tags`));
	assert.equal(n8n.store.get(String(draft.json.draftId))!.active, false);
});

// ---------------------------------------------------------------- approval tokens

test('An approval token carries draft, hash, person and decision, and nothing else verifies', () => {
	const input = { draftId: 'd1', contentHash: 'h1', approver: ' Anna@Example.com ', decision: 'approve' as const };
	const { token, expiresAt } = issueToken(SEAL_KEY, input, { validHours: 2, now: NOW });
	assert.match(token, TOKEN_PATTERN);
	assert.equal(expiresAt, '2026-11-02T10:00:00.000Z');
	const ok = verifyToken(SEAL_KEY, token, { now: NOW });
	assert.equal(ok.valid, true);
	assert.deepEqual(ok.claims, { draftId: 'd1', contentHash: 'h1', approver: 'anna@example.com', decision: 'approve', exp: Date.parse(expiresAt) / 1000 });

	// A reject link turned into an approve link: the signature no longer fits.
	const [prefix, body, sig] = issueToken(SEAL_KEY, { ...input, decision: 'reject' }, { now: NOW }).token.split('.');
	const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
	const forged = `${prefix}.${Buffer.from(JSON.stringify({ ...claims, decision: 'approve' })).toString('base64url')}.${sig}`;
	assert.equal(verifyToken(SEAL_KEY, forged, { now: NOW }).valid, false);
	assert.equal(verifyToken('x'.repeat(40), token, { now: NOW }).valid, false, 'another key');
	assert.match(verifyToken(SEAL_KEY, token, { now: new Date('2026-11-02T10:00:00Z') }).reason, /expired/);
	assert.equal(verifyToken(SEAL_KEY, signSeal(SEAL_KEY, 'post', { a: 1 }, 'anna@example.com')).valid, false, 'a seal is no token');
	assert.equal(verifyToken(SEAL_KEY, `${token}"><script>`, { now: NOW }).valid, false);
	assert.throws(() => issueToken('short', input), /at least 32/);
	assert.throws(() => issueToken(SEAL_KEY, { ...input, approver: 'nobody' }), /approver/);
});

test('The links of Issue Approval Tokens work once: Verify gives the claims, a second Apply finds no draft', async () => {
	const n8n = fakeN8n([managedWf('w1')]);
	const plan = checkPlan(planCtx(), newWorkflow([schedule, runner]));
	const draft = await n8n.api.create(draftWorkflow(plan, change));
	const { hash } = draftHash(draft);
	const builder = new RoleAlphaWorkflowBuilder();

	const issue = nodeCtx({ operation: 'issueTokens', draftId: draft.id, contentHash: hash, approver: 'anna@example.com', validHours: 24 }, {});
	issue.ctx.getInputData = () => [{ json: { email: 'anna@example.com', name: 'Anna' } }];
	const [[links]] = await builder.execute.call(issue.ctx);
	const { approveToken, rejectToken, name } = links.json as any;
	assert.equal(name, 'Anna', 'the input stays on the item');
	assert.notEqual(approveToken, rejectToken);

	const verify = async (token: string) => (await builder.execute.call(nodeCtx({ operation: 'verifyToken', token }, {}).ctx))[0][0].json as any;
	const claims = await verify(approveToken);
	assert.deepEqual([claims.draftId, claims.contentHash, claims.approver, claims.decision], [draft.id, hash, 'anna@example.com', 'approve']);
	assert.equal((await verify(rejectToken)).decision, 'reject');
	await assert.rejects(verify(approveToken.slice(0, -2) + 'AA'), /not valid/);

	const apply = () => builder.execute.call(nodeCtx({ operation: 'applyDraft', draftId: claims.draftId, approvedHash: claims.contentHash }, { n8n }).ctx);
	const [[applied]] = await apply();
	assert.equal((applied.json as any).applied, true);
	await assert.rejects(apply(), /no roleALPHA draft/);
	const discard = () => builder.execute.call(nodeCtx({ operation: 'discardDraft', draftId: claims.draftId }, { n8n }).ctx);
	await assert.rejects(discard(), /no roleALPHA draft/);
});
