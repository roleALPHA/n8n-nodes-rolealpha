import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EntityChange } from '../lib/changes';
import { withRetries } from '../lib/changes';
import {
	applyDraft,
	changedCode,
	checkPlan,
	DEFAULT_NODE_TYPES,
	diffWorkflows,
	draftHash,
	draftWorkflow,
	findRunner,
	markerNode,
	N8nApi,
	readBinding,
	reviewHtml,
	summarizeOthers,
	summarizeWorkflows,
	triage,
	type N8nWorkflow,
	type PlanContext,
} from '../lib/workflows';
import { RoleAlphaWorkflowBuilder } from '../nodes/RoleAlphaWorkflowBuilder/RoleAlphaWorkflowBuilder.node';

const STEP = 's3000000-0000-4000-8000-000000000001';
const OTHER = 's3000000-0000-4000-8000-000000000002';

const change = (extra: Partial<EntityChange> = {}): EntityChange => ({ change: 'created', uuid: STEP, name: 'Publish', entityType: 'process', customId: 'mk:publish', changedAt: '2026-11-03T12:00:00.000Z', relationships: [], workflows: [], ...extra });
const step = (extra: Record<string, unknown> = {}) => ({ step: { uuid: STEP, children: [], predecessors: [], successors: [], parents: [], subtype: 'step', frequency: 'event_driven', status: 'active', ...extra } });

const runnerWf: N8nWorkflow = {
	id: 'run1',
	name: 'Agent: Runner',
	active: true,
	nodes: [{ name: 'Start', type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1.1, position: [0, 0], parameters: { workflowInputs: { values: [{ name: 'agentUuid' }, { name: 'stepUuid' }, { name: 'stepCustomId' }, { name: 'triggerType' }, { name: 'event' }, { name: 'organisation' }, { name: 'roleUuid' }] } } }],
	connections: {},
};
const routerWf: N8nWorkflow = {
	id: 'other1',
	name: 'Agent: Event Router',
	active: true,
	nodes: [{ name: 'Hook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], parameters: { path: 'agent-event' } }],
	connections: {},
};

const ctxOf = (over: Partial<PlanContext> = {}, raw: N8nWorkflow[] = [runnerWf, routerWf], managed: N8nWorkflow[] = []): PlanContext => {
	const m = summarizeWorkflows(managed);
	const c = over.change ?? change();
	return {
		change: c,
		entity: step(),
		workflows: m.workflows,
		affected: [],
		credentials: m.credentials,
		nodeTypes: DEFAULT_NODE_TYPES,
		others: summarizeOthers([...raw, ...managed], c.customId),
		runner: findRunner(raw, 'Agent: Runner'),
		endpointUrl: 'https://rolealpha.app/api/mcp',
		organisation: '3399e431-ce95-4fcb-b183-e4c0cf2772ad',
		...over,
	};
};

const answer = (nodes: unknown[], connections: unknown = {}, extra: Record<string, unknown> = {}) => ({ action: 'create', reason: 'Needed', targetWorkflowId: null, workflow: { name: 'New flow', nodes, connections }, ...extra });
const webhook = (path = 'publish') => ({ name: 'Hook', type: 'n8n-nodes-base.webhook', typeVersion: 2, parameters: { path } });
const set = (name: string, parameters: unknown = {}) => ({ name, type: 'n8n-nodes-base.set', typeVersion: 3.4, parameters });
const link = (from: string, to: string) => ({ [from]: { main: [[{ node: to, type: 'main', index: 0 }]] } });

// ---------------------------------------------------------------- the run of 2026-11-03

/**
 * The first real run: the builder's own chain was approved in roleALPHA. Five changes went to
 * the model, and it proposed a second detect workflow for one of them. Now no model is asked.
 */
test('The run of 2026-11-03: all five changes are decided without a model', () => {
	const own = { ownPrefixes: ['automation:'], schedulerCoversFrequency: true };
	const decide = (customId: string, entity: unknown) => triage(ctxOf({ change: change({ customId }), entity }), own)?.rule;
	assert.equal(decide('it:wsk', step({ children: [{ uuid: OTHER }] })), 'grouping');
	assert.equal(decide('automation:vs-workflows', step({ children: [{ uuid: OTHER }] })), 'own_step');
	assert.equal(decide('automation:workflow-detect', step({ frequency: 'daily' })), 'own_step');
	assert.equal(decide('automation:workflow-propose', step()), 'own_step');
	assert.equal(decide('automation:workflow-changes', step({ subtype: 'gate' })), 'own_step');
});

test('The second detect workflow of that run would be refused by its hand-over', () => {
	const plan = checkPlan(ctxOf(), answer(
		[{ name: 'Every 15', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, parameters: {} }, { name: 'Run', type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1.3, parameters: { workflowId: { __rl: true, mode: 'id', value: 'gone' } } }],
		link('Every 15', 'Run'),
	));
	assert.match(plan.problems.join(), /starts workflow "gone", which does not exist/);
	const wrong = checkPlan(ctxOf(), answer(
		[{ name: 'Every 15', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, parameters: {} }, { name: 'Run', type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1.3, parameters: { workflowId: { __rl: true, mode: 'id', value: 'run1' }, workflowInputs: { value: { agentUuid: 'x', step: 'y', trigger: 'z' } } } }],
		link('Every 15', 'Run'),
	));
	assert.match(wrong.problems.join(), /passes "step", but "Agent: Runner" takes only/);
	assert.match(wrong.problems.join(), /passes "trigger"/);
});

// ---------------------------------------------------------------- triage

test('Triage leaves everything else to the model', () => {
	const plain = { ownPrefixes: ['automation:'], schedulerCoversFrequency: true };
	assert.equal(triage(ctxOf(), plain), null, 'an event-driven step may need a trigger');
	assert.equal(triage(ctxOf({ entity: step({ frequency: 'weekly' }) }), plain)?.rule, 'scheduled');
	assert.equal(triage(ctxOf({ entity: step({ frequency: 'weekly' }) }), { schedulerCoversFrequency: false }), null, 'without a generic scheduler the model decides');
	assert.equal(triage(ctxOf({ entity: step({ subtype: 'gate' }) }), plain)?.rule, 'decision');
	assert.equal(triage(ctxOf({ entity: step({ status: 'archived' }) }), plain)?.rule, 'retired');
	const affected = [{ workflowId: 'w1', name: 'x', as: 'bound' as const }];
	assert.equal(triage(ctxOf({ entity: step({ subtype: 'gate' }), affected }), plain), null, 'a workflow depends on it');
	assert.equal(triage(ctxOf({ entity: null }), plain), null, 'not a step');
	assert.equal(triage(ctxOf({ change: change({ change: 'removed' }), entity: null }), plain), null);
});

const waitingDraft = (madeAt: string): N8nWorkflow => ({
	id: 'd1',
	name: 'Draft: x',
	nodes: [markerNode({ managed: true, entities: [STEP], draft: { action: 'create', targetWorkflowId: null, targetVersion: null, entityUuid: STEP, change: 'created', contentHash: 'h', reason: 'r', madeAt } })],
	connections: {},
});

test('A change a waiting draft covers asks nothing again; a later change does', () => {
	const madeAt = '2026-11-03T12:30:00.000Z';
	const again = triage(ctxOf({ change: change({ changedAt: '2026-11-03T12:00:00.000Z' }) }, undefined, [waitingDraft(madeAt)]));
	assert.equal(again?.rule, 'draft_waiting', 'list_changes delivers at least once');
	assert.equal(triage(ctxOf({ change: change({ changedAt: '2026-11-03T13:00:00.000Z' }) }, undefined, [waitingDraft(madeAt)])), null);
});

// ---------------------------------------------------------------- templates

test('The schedule template builds the hand-over from what the runner takes', () => {
	const plan = checkPlan(ctxOf({ credentials: [{ id: 'm1', name: 'roleALPHA MCP', type: 'mcpOAuth2Api' }] }), { action: 'create', reason: 'Needs a schedule', targetWorkflowId: null, workflow: null, template: 'schedule', templateValues: { cron: '0 7 * * 1' } });
	assert.equal(plan.ok, true, plan.problems.join('; '));
	assert.equal(plan.template, 'schedule');
	const by = Object.fromEntries(plan.workflow!.nodes.map((n) => [n.name, n]));
	assert.equal((by.Schedule.parameters.rule as any).interval[0].expression, '0 7 * * 1');
	assert.deepEqual(by['Get step'].credentials, { mcpOAuth2Api: { id: 'm1', name: 'roleALPHA MCP' } });
	assert.equal(by['Get step'].parameters.step, 'mk:publish');
	const run = by['Run agent'].parameters as any;
	assert.equal(run.workflowId.value, 'run1');
	assert.deepEqual(Object.keys(run.workflowInputs.value), ['agentUuid', 'stepUuid', 'stepCustomId', 'triggerType', 'event', 'organisation', 'roleUuid']);
	assert.equal(run.workflowInputs.value.triggerType, 'schedule');
	assert.equal(run.workflowInputs.value.roleUuid, '');
	assert.equal(plan.workflow!.name, 'roleALPHA: Publish (mk:publish)');
});

test('The same answer gives the same workflow, every time', () => {
	const a = { action: 'create', reason: 'x', targetWorkflowId: null, workflow: null, template: 'schedule', templateValues: { cron: '0 7 * * 1' } };
	assert.equal(checkPlan(ctxOf(), a).contentHash, checkPlan(ctxOf(), { ...a, reason: 'other words' }).contentHash);
});

test('The event template needs a header credential to run, and says so', () => {
	const plan = checkPlan(ctxOf(), { action: 'create', reason: 'Directus starts it', targetWorkflowId: null, workflow: null, template: 'event' });
	assert.equal(plan.ok, true, plan.problems.join('; '));
	const hook = plan.workflow!.nodes.find((n) => n.name === 'Event')!;
	assert.equal(hook.parameters.path, 'rolealpha-mk-publish');
	assert.equal(hook.parameters.authentication, 'headerAuth');
	assert.ok(hook.webhookId);
	assert.match(plan.notes.join(), /Header Auth credential/);
	assert.match(plan.notes.join(), /POST \/webhook\/rolealpha-mk-publish/);
});

test('A template fails without what it needs', () => {
	const t = (over: Partial<PlanContext>, a: Record<string, unknown> = {}) => checkPlan(ctxOf(over), { action: 'create', reason: 'x', targetWorkflowId: null, workflow: null, template: 'schedule', templateValues: { cron: '0 7 * * 1' }, ...a });
	assert.match(t({ runner: null }).problems.join(), /Runner Workflow/);
	assert.match(t({ change: change({ customId: null }) }).problems.join(), /custom ID/);
	assert.match(t({}, { templateValues: { cron: 'every day' } }).problems.join(), /five fields/);
	assert.match(t({}, { templateValues: { cron: '0 7 * * $(rm)' } }).problems.join(), /five fields/);
	assert.match(t({}, { template: 'mine' }).problems.join(), /Unknown template/);
	assert.match(checkPlan(ctxOf({ runner: { id: 'x', name: 'Odd', inputs: ['foo'] } , others: summarizeOthers([{ ...runnerWf, id: 'x', name: 'Odd' }]) }), { action: 'create', reason: 'x', targetWorkflowId: null, workflow: null, template: 'schedule', templateValues: { cron: '0 7 * * 1' } }).problems.join(), /takes no agentUuid/);
});

// ---------------------------------------------------------------- the check

test('Nothing is built twice', () => {
	const same = checkPlan(ctxOf(), { ...answer([webhook()]), workflow: { name: 'agent: event router', nodes: [webhook()], connections: {} } });
	assert.match(same.problems.join(), /named "Agent: Event Router" exists/);
	assert.match(checkPlan(ctxOf(), answer([webhook('agent-event')])).problems.join(), /path "agent-event" is taken by "Agent: Event Router"/);
	const naming: N8nWorkflow = { ...routerWf, id: 'o2', name: 'Old publish', nodes: [{ ...routerWf.nodes[0], parameters: { path: 'old', note: 'mk:publish' } }] };
	assert.match(checkPlan(ctxOf({}, [runnerWf, naming]), answer([webhook()])).problems.join(), /"Old publish" already names mk:publish/);
	const longer: N8nWorkflow = { ...naming, nodes: [{ ...routerWf.nodes[0], parameters: { path: 'old', note: 'mk:publish-later and xmk:publish' } }] };
	assert.equal(checkPlan(ctxOf({}, [runnerWf, longer]), answer([webhook()])).ok, true, 'a longer custom ID is another step');
});

test('A workflow nobody starts, or with a node nothing reaches, is refused', () => {
	assert.match(checkPlan(ctxOf(), answer([set('Alone')])).problems.join(), /no trigger/);
	assert.match(checkPlan(ctxOf(), answer([webhook(), set('Alone')])).problems.join(), /"Alone" is connected to no trigger/);
	assert.equal(checkPlan(ctxOf(), answer([webhook(), set('Next')], link('Hook', 'Next'))).ok, true);
	const sticky = { name: 'Note', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, parameters: { content: 'x' } };
	assert.equal(checkPlan(ctxOf(), answer([webhook(), sticky])).ok, true, 'a note needs no connection');
});

test('A draft calls no internal address', () => {
	const call = (url: string) => answer([webhook(), set('Next', { url })], link('Hook', 'Next'));
	for (const bad of ['http://localhost:5678/webhook/zammad-proxy', 'http://127.0.0.1:5678/webhook/x', 'http://[::1]:5678/x', 'http://zammad-zammad-nginx-1:8080/api/v1/users', '=https://n8n.example.com/webhook/zammad-proxy', 'https://n8n.example.com/webhook-test/kb-quellen', '={{ $json.base }}/webhook/kb-quellen']) {
		assert.match(checkPlan(ctxOf(), call(bad)).problems.join(), /calls an internal address/, bad);
	}
	assert.equal(checkPlan(ctxOf(), call('https://api.example.com/webhook/orders')).ok, true);
	assert.equal(checkPlan(ctxOf(), call('the word localhost in a text')).ok, true, 'only an address counts');
	const note = { name: 'Note', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [0, 0], parameters: { content: 'see http://localhost:5678/webhook/zammad-proxy' } };
	assert.equal(checkPlan(ctxOf(), answer([webhook(), note])).ok, true, 'a note may mention it');
});

test('Expressions stay with their data and read existing nodes', () => {
	const expr = (value: string) => answer([webhook(), set('Next', { value })], link('Hook', 'Next'));
	for (const bad of ['={{ $env.ZAMMAD_API_TOKEN }}', '={{ process.env.X }}', '={{ $secrets.a }}', '={{ ({}).constructor.constructor("return 1")() }}', 'token {{ $vars.x }}']) {
		assert.match(checkPlan(ctxOf(), expr(bad)).problems.join(), /reaches beyond its data/, bad);
	}
	assert.equal(checkPlan(ctxOf(), expr('the process is called $env, not an expression')).ok, true, 'plain text is no expression');
	assert.equal(checkPlan(ctxOf(), expr('=The process of {{ $json.process }} and {{ $json.function }}')).ok, true, 'the word alone is data');
	assert.equal(checkPlan(ctxOf(), expr("={{ $('Hook').first().json.body }}")).ok, true);
	assert.match(checkPlan(ctxOf(), expr("={{ $('Gone').first().json }}")).problems.join(), /reads node "Gone"/);
	assert.match(checkPlan(ctxOf(), expr('={{ $node["Gone"].json }}')).problems.join(), /reads node "Gone"/);
});

test('The organisation may stand in a workflow, other UUIDs may not', () => {
	const org = '3399e431-ce95-4fcb-b183-e4c0cf2772ad';
	assert.equal(checkPlan(ctxOf(), answer([webhook(), set('Next', { organisation: org })], link('Hook', 'Next'))).ok, true);
	assert.match(checkPlan(ctxOf(), answer([webhook(), set('Next', { role: '9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f' })], link('Hook', 'Next'))).problems.join(), /contains a UUID/);
});

test('Types that run what no check can read are never allowed', () => {
	const shell = { name: 'Shell', type: 'n8n-nodes-base.executeCommand', typeVersion: 1, parameters: { command: 'ls' } };
	const plan = checkPlan(ctxOf({ nodeTypes: [...DEFAULT_NODE_TYPES, shell.type] }), answer([webhook(), shell], link('Hook', 'Shell')));
	assert.match(plan.problems.join(), /"Shell" has type .* not allowed/);
});

// ---------------------------------------------------------------- code nodes

const codeNode = (jsCode: string, name = 'Shape') => ({ name, type: 'n8n-nodes-base.code', typeVersion: 2, parameters: { mode: 'runOnceForAllItems', jsCode } });
const doubled = `return $input.all().map((i) => ({ json: { n: i.json.n * 2 } }));`;
const codeTests = { Shape: [{ name: 'doubles', input: [{ n: 2 }], expected: [{ n: 4 }] }] };
const withCode = (jsCode = doubled, tests: unknown = codeTests) => answer([webhook(), codeNode(jsCode)], link('Hook', 'Shape'), { codeTests: tests });

test('Code nodes stay out unless allowed, and while n8n leaves the environment open', () => {
	assert.match(checkPlan(ctxOf(), withCode()).problems.join(), /Code node, which is not allowed here/);
	assert.match(checkPlan(ctxOf({ allowCode: true, envBlocked: false }), withCode()).problems.join(), /N8N_BLOCK_ENV_ACCESS_IN_NODE=false/);
	assert.match(checkPlan(ctxOf({ nodeTypes: [...DEFAULT_NODE_TYPES, 'n8n-nodes-base.code'] }), withCode()).problems.join(), /not allowed here/, 'the allow list alone is not enough');
});

test('Allowed code passes only with the check and its tests', () => {
	const allow = { allowCode: true, envBlocked: true };
	const good = checkPlan(ctxOf(allow), withCode());
	assert.equal(good.ok, true, good.problems.join('; '));
	assert.deepEqual(good.code, [{ node: 'Shape', tests: 1 }]);
	assert.match(checkPlan(ctxOf(allow), withCode('return $env.X;')).problems.join(), /Code node "Shape" uses "\$env"/);
	assert.match(checkPlan(ctxOf(allow), withCode(doubled, {})).problems.join(), /no test/);
	assert.match(checkPlan(ctxOf(allow), withCode(doubled, { Shape: [{ input: [{ n: 2 }], expected: [{ n: 5 }] }] })).problems.join(), /expected/);
	assert.match(checkPlan(ctxOf(allow), withCode("return [{ json: { to: 'anna@example.com' } }];", { Shape: [{ expected: [{ to: 'anna@example.com' }] }] })).problems.join(), /e-mail address/);
	const py = answer([webhook(), { ...codeNode(''), parameters: { language: 'python', pythonCode: 'import os' } }], link('Hook', 'Shape'));
	assert.match(checkPlan(ctxOf(allow), py).problems.join(), /not JavaScript/);
});

const managedWithCode = (jsCode: string): N8nWorkflow => ({
	id: 'w1',
	name: 'Managed',
	active: true,
	versionId: 'v1',
	nodes: [{ id: 'a', name: 'Hook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], parameters: { path: 'p' } }, { id: 'b', position: [1, 0], ...codeNode(jsCode) } as any, markerNode({ managed: true, entities: [STEP] })],
	connections: link('Hook', 'Shape') as any,
	settings: {},
});

test('Code that was approved before stays without the code option; changing it needs everything', () => {
	const target = managedWithCode('return $env.OLD;');
	const keep = { action: 'update', reason: 'Add a node', targetWorkflowId: 'w1', workflow: { name: 'Managed', nodes: [...target.nodes.slice(0, 2), set('More')], connections: { ...target.connections, ...link('Shape', 'More') } } };
	const ctx = ctxOf({ affected: [{ workflowId: 'w1', name: 'Managed', as: 'bound' }] }, undefined, [target]);
	const kept = checkPlan(ctx, keep, target);
	assert.equal(kept.ok, true, kept.problems.join('; '));
	assert.equal(kept.code, undefined);
	const changed = { ...keep, workflow: { ...keep.workflow, nodes: [target.nodes[0], codeNode('return $env.NEW;'), set('More')] } };
	assert.match(checkPlan(ctx, changed, target).problems.join(), /Code node, which is not allowed here/);
});

function fakeApi(initial: N8nWorkflow[]) {
	const store = new Map(initial.map((w) => [w.id!, structuredClone(w)]));
	let next = 100;
	const api = new N8nApi(async (method, path, body) => {
		const id = decodeURIComponent(path.split('/')[2] ?? '');
		if (method === 'GET' && path === '/workflows') return { data: [...store.values()], nextCursor: null };
		if (method === 'GET' && path === '/tags') return { data: [] };
		if (method === 'POST' && path === '/tags') return { id: 't', name: 'x' };
		if (method === 'POST' && path === '/workflows') {
			const wf = { ...(body as N8nWorkflow), id: `d${next++}`, active: false, versionId: 'dv1' };
			store.set(wf.id, wf);
			return wf;
		}
		if (path.endsWith('/tags')) return [];
		if (method === 'GET') {
			if (!store.has(id)) throw new Error('404');
			return structuredClone(store.get(id));
		}
		if (method === 'PUT') return void store.set(id, { ...store.get(id)!, ...(body as N8nWorkflow) });
		if (method === 'DELETE') return void store.delete(id);
		return {};
	});
	return { api, store };
}

test('Apply refuses a draft with changed code unless it was approved as such', async () => {
	const plan = checkPlan(ctxOf({ allowCode: true, envBlocked: true }), withCode());
	const { api, store } = fakeApi([]);
	const draft = await api.create(draftWorkflow(plan, change()));
	const { hash } = draftHash(draft);
	await assert.rejects(applyDraft(api, draft.id!, hash), /changes Code nodes/);
	const res = await applyDraft(api, draft.id!, hash, { codeApproved: true });
	assert.equal(res.applied, true);
	assert.ok(store.has(draft.id!));
});

test('Changed code is told from kept code', () => {
	const target = managedWithCode('return [];');
	assert.deepEqual(changedCode(target, target), []);
	assert.deepEqual(changedCode(target, null).map((c) => c.node), ['Shape']);
	assert.deepEqual(changedCode(managedWithCode('return [1];'), target).map((c) => c.jsCode), ['return [1];']);
});

// ---------------------------------------------------------------- what the approver sees

test('The approver sees what changes, escaped', () => {
	const before = managedWithCode('return [];');
	const after = { nodes: [before.nodes[0], { ...before.nodes[1], parameters: { ...before.nodes[1].parameters, jsCode: 'return [1];' } }, set('More') as any], connections: { ...before.connections, ...link('Shape', 'More') } as any };
	const diff = diffWorkflows(before, after);
	assert.deepEqual(diff, ['~ node "Shape": jsCode', '+ node "More" (n8n-nodes-base.set)', '+ Shape → More']);
	assert.deepEqual(diffWorkflows(before, { nodes: before.nodes.slice(0, 1), connections: {} }), ['- node "Shape"', '- Hook → Shape']);
	const html = reviewHtml(['+ node "<x>"'], [{ node: '<b>', jsCode: 'return "<script>";' }]);
	assert.ok(!html.includes('<script>'));
	assert.ok(!html.includes('<x>'));
	assert.match(html, /&lt;script&gt;/);
});

// ---------------------------------------------------------------- the node

function nodeCtx(params: Record<string, unknown>, opts: { n8n: ReturnType<typeof fakeApi>; answers?: Array<string | Error>; staticData?: Record<string, unknown> }) {
	const prompts: unknown[] = [];
	const staticData = opts.staticData ?? {};
	let invoked = 0;
	const ctx: any = {
		getWorkflowStaticData: () => staticData,
		getInputData: () => [{ json: {} }],
		getNodeParameter: (name: string, _i: number, fallback?: unknown) => (name in params ? params[name] : fallback),
		getCredentials: async (type: string) => (type === 'n8nApi' ? { baseUrl: 'https://n8n.example.com/api/v1/', apiKey: 'k' } : {}),
		getNode: () => ({ name: 'test', type: 'test', typeVersion: 1, position: [0, 0], parameters: {}, credentials: { mcpOAuth2Api: { id: 'm1', name: 'roleALPHA MCP' } } }),
		continueOnFail: () => false,
		getInputConnectionData: async () => ({
			invoke: async (messages: unknown) => {
				invoked++;
				prompts.push(structuredClone(messages));
				const next = opts.answers?.shift() ?? '{}';
				if (next instanceof Error) throw next;
				return { content: next };
			},
		}),
		helpers: {
			httpRequestWithAuthentication: async (type: string, req: any) => {
				if (type === 'n8nApi') return (opts.n8n.api as any).request(req.method, req.url.slice('https://n8n.example.com/api/v1'.length), req.body, req.qs);
				const msg = JSON.parse(req.body);
				if (msg.id === undefined) return { statusCode: 202, headers: {}, body: '' };
				const tools: Record<string, (a: any) => unknown> = {
					get_entity_details: (a) => ({ uuid: a.entityUuid, name: 'Publish', customerId: (params as any).customId ?? 'mk:publish', entityTypeName: 'Value Creation', descJsonb: { status: 'active', ...(params as any).stepData } }),
					get_entity_relationships: () => ({ relationships: [] }),
				};
				const result = msg.method === 'tools/call' ? { content: [{ type: 'text', text: JSON.stringify(tools[msg.params.name](msg.params.arguments)) }] } : {};
				return { statusCode: 200, headers: { 'mcp-session-id': 's1' }, body: JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) };
			},
		},
	};
	return { ctx, prompts, invoked: () => invoked };
}

const propose = (extra: Record<string, unknown> = {}) => ({ operation: 'propose', endpointUrl: 'https://ra/mcp', organisation: 'org', change: change({ customId: null }), maxAttempts: 2, ...extra });

test('Propose decides a rule case without asking the model', async () => {
	const n8n = fakeApi([runnerWf]);
	const run = nodeCtx(propose({ customId: 'automation:x' }), { n8n, answers: ['{"action":"create"}'] });
	const [[item]] = await new RoleAlphaWorkflowBuilder().execute.call(run.ctx);
	const res = item.json as any;
	assert.deepEqual([res.ok, res.action, res.decidedBy, res.rule, res.attempts], [true, 'none', 'rule', 'own_step', 0]);
	assert.equal(run.invoked(), 0);
});

test('Propose tells the model about the runner and the other workflows, and fills its own credential', async () => {
	const n8n = fakeApi([runnerWf, routerWf]);
	const a = JSON.stringify({ action: 'create', reason: 'Starts on an event', targetWorkflowId: null, workflow: null, template: 'schedule', templateValues: { cron: '0 7 * * *' } });
	const run = nodeCtx(propose({ proposeOptions: { runnerWorkflow: 'Agent: Runner' } }), { n8n, answers: [a] });
	const [[item]] = await new RoleAlphaWorkflowBuilder().execute.call(run.ctx);
	const res = item.json as any;
	assert.equal(res.ok, true, res.problems.join('; '));
	assert.equal(res.decidedBy, 'model');
	assert.deepEqual(res.workflow.nodes.find((n: any) => n.name === 'Get step').credentials, { mcpOAuth2Api: { id: 'm1', name: 'roleALPHA MCP' } });
	const [system, human] = run.prompts[0] as Array<[string, string]>;
	assert.match(system[1], /exactly these inputs: agentUuid, stepUuid/);
	assert.match(human[1], /Agent: Event Router/);
	assert.match(human[1], /agent-event/);
});

test('A model that is away costs nothing: the change comes back and is answered later', async () => {
	const n8n = fakeApi([runnerWf]);
	const staticData: Record<string, unknown> = {};
	const builder = new RoleAlphaWorkflowBuilder();
	const failing = nodeCtx(propose(), { n8n, answers: [new Error('overloaded')], staticData });
	const [[first]] = await builder.execute.call(failing.ctx);
	const res = first.json as any;
	assert.deepEqual([res.ok, res.retry, res.decidedBy], [false, true, 'failed']);
	assert.match(res.problems[0], /overloaded/);
	const stored = (staticData.proposeRetry as any)[STEP];
	assert.equal(stored.tries, 1);

	const merged = withRetries([], staticData.proposeRetry as any);
	assert.deepEqual(merged.map((c) => c.uuid), [STEP]);
	const next = nodeCtx(propose({ change: merged[0] }), { n8n, answers: ['{"action":"none","reason":"nothing to do"}'], staticData });
	const [[second]] = await builder.execute.call(next.ctx);
	assert.equal((second.json as any).ok, true);
	assert.equal(staticData.proposeRetry, undefined);
});

test('After too many tries a change is given up, and says so', async () => {
	const n8n = fakeApi([runnerWf]);
	const staticData: Record<string, unknown> = { proposeRetry: { [STEP]: { change: change(), tries: 4 } } };
	const run = nodeCtx(propose(), { n8n, answers: [new Error('still away')], staticData });
	const [[item]] = await new RoleAlphaWorkflowBuilder().execute.call(run.ctx);
	const res = item.json as any;
	assert.deepEqual([res.ok, res.retry], [false, false]);
	assert.match(res.problems[0], /try 5 of 5/);
	assert.equal(staticData.proposeRetry, undefined);
});

test('Fresh changes keep their row and take the relationships of the failed one', () => {
	const failed = change({ relationships: [{ type: 'DEPENDS_ON', action: 'added', otherUuid: OTHER, end: 'to' }] });
	const fresh = change({ change: 'changed' });
	const merged = withRetries([fresh], { [STEP]: { change: failed, tries: 1 } });
	assert.equal(merged.length, 1);
	assert.equal(merged[0].change, 'changed');
	assert.equal(merged[0].relationships.length, 1);
});

test('A newer draft replaces the older one of the same entity; Read Draft tells about code', async () => {
	const n8n = fakeApi([]);
	const builder = new RoleAlphaWorkflowBuilder();
	const plan = checkPlan(ctxOf({ allowCode: true, envBlocked: true }), withCode());
	const proposal = { ...plan, change: change() };
	const make = async () => (await builder.execute.call(nodeCtx({ operation: 'createDraft', proposal }, { n8n }).ctx))[0][0].json as any;
	const first = await make();
	assert.deepEqual([first.codeChanged, first.codeNodes, first.replacedDrafts], [true, ['Shape'], []]);
	assert.match(first.reviewHtml, /Code in node Shape/);
	assert.ok(first.diff.includes('+ node "Shape" (n8n-nodes-base.code)'));
	const second = await make();
	assert.deepEqual(second.replacedDrafts, [first.draftId]);
	assert.equal(n8n.store.has(first.draftId), false);
	assert.equal(readBinding(n8n.store.get(second.draftId)!)?.draft?.entityUuid, STEP);
	const [[read]] = await builder.execute.call(nodeCtx({ operation: 'readDraft', draftId: second.draftId }, { n8n }).ctx);
	assert.deepEqual([(read.json as any).codeChanged, (read.json as any).codeNodes, (read.json as any).contentHash], [true, ['Shape'], second.contentHash]);
	const [[plain]] = await builder.execute.call(nodeCtx({ operation: 'applyDraft', draftId: second.draftId, approvedHash: second.contentHash, codeApproved: true }, { n8n }).ctx);
	assert.equal((plain.json as any).applied, true);
});
