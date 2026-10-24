import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getCircleLeads, getStep } from '../lib/graph';
import { buildShareInput, checkShare } from '../lib/share';
import { DEFAULT_SETTINGS, checkSetting, resolveSettings } from '../lib/settings';
import { MAX_EVENT_CHARS, MAX_REASON_CHARS, checkStart, clip, findStaleWaits, parseEvent, planAfterRun, type WaitRow } from '../lib/waits';
import type { ContextBundle } from '../lib/prompt';
import { RoleAlpha } from '../nodes/RoleAlpha/RoleAlpha.node';
import { CIRCLE, FakeGraph, PERSON_B, ROLE_ASSIST, ROLE_DECIDE, ROLE_LEAD, sampleGraph } from './fixtures';

const STEP = 's1000000-0000-4000-8000-000000000001';
const TEXT = 'r1000000-0000-4000-8000-000000000001';
const VISUAL = 'r1000000-0000-4000-8000-000000000002';
const VIDEO = 'r1000000-0000-4000-8000-000000000003';
const REVIEW = 'r1000000-0000-4000-8000-000000000004';
const A_TEXT = 'a1000000-0000-4000-8000-000000000001';
const A_VISUAL = 'a1000000-0000-4000-8000-000000000002';
const PERSON = 'u1000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-10-23T10:00:00Z');

function ctxFor(params: Record<string, unknown>) {
	return {
		getInputData: () => [{ json: {} }],
		getNodeParameter: (name: string, _i: number, fallback?: unknown) => (name in params ? params[name] : fallback),
		getNode: () => ({ name: 'test', type: 'test', typeVersion: 1, position: [0, 0], parameters: {} }),
		continueOnFail: () => false,
	} as any;
}

// ---------------------------------------------------------------- settings

test('settings: defaults, then global < step < agent, whatever the row order', () => {
	const rows = [
		{ scope: 'agent', target: A_TEXT.toUpperCase(), key: 'maxAttempts', value: '2' },
		{ scope: 'step', target: 'x:content', key: 'maxAttempts', value: 4 },
		{ scope: '', key: 'maxAttempts', value: 3 },
		{ scope: 'global', key: 'MAXWAITMINUTES', value: '30' },
		{ scope: 'step', target: STEP, key: 'escalate', value: 'nein' },
		{ scope: 'agent', target: A_VISUAL, key: 'maxIterations', value: 7 },
	];
	const forText = resolveSettings(rows, { agentUuid: A_TEXT, stepUuid: STEP, stepCustomId: 'x:content' });
	assert.equal(forText.settings.maxAttempts, 2);
	assert.equal(forText.sources.maxAttempts, 'agent');
	assert.equal(forText.settings.maxWaitMinutes, 30);
	assert.equal(forText.settings.escalate, false);
	assert.equal(forText.settings.maxIterations, DEFAULT_SETTINGS.maxIterations, 'another agent\'s row does not apply');
	assert.deepEqual(forText.problems, []);

	const elsewhere = resolveSettings(rows, { agentUuid: A_VISUAL, stepUuid: 'other' });
	assert.equal(elsewhere.settings.maxAttempts, 3);
	assert.equal(elsewhere.settings.maxIterations, 7);
	assert.equal(elsewhere.settings.escalate, true);
	assert.deepEqual(resolveSettings([]).settings, DEFAULT_SETTINGS);
});

test('settings: values are clamped, unknown keys and scopes are reported and never applied', () => {
	const res = resolveSettings([
		{ scope: 'global', key: 'maxAttempts', value: 1000 },
		{ scope: 'global', key: 'runTimeoutMinutes', value: -5 },
		{ scope: 'global', key: 'maxIterations', value: 'lots' },
		{ scope: 'global', key: '__proto__', value: 1 },
		{ scope: 'org', key: 'maxAttempts', value: 1 },
		{ scope: 'step', target: '', key: 'maxAttempts', value: 1 },
		null as any,
	]);
	assert.equal(res.settings.maxAttempts, 20);
	assert.equal(res.settings.runTimeoutMinutes, 1);
	assert.equal(res.settings.maxIterations, DEFAULT_SETTINGS.maxIterations);
	assert.equal(res.problems.length, 5);
	assert.match(res.problems.join('\n'), /clamped to 20/);
	assert.match(res.problems.join('\n'), /unknown key/);
	assert.match(res.problems.join('\n'), /unknown scope/);
	assert.equal(({} as any).polluted, undefined);
	assert.deepEqual(checkSetting('escalate', 'maybe'), null);
	assert.deepEqual(checkSetting('shareCacheHours', 0), { value: 0 });
	assert.deepEqual(checkSetting('maxWaitMinutes', '12.6'), { value: 13 });
});

test('node: Settings → Resolve passes the item on with the settings', async () => {
	const [[item]] = await new RoleAlpha().execute.call(
		ctxFor({ resource: 'settings', operation: 'resolve', settingRows: [{ scope: 'agent', target: A_TEXT, key: 'maxIterations', value: 99 }], settingsAgent: A_TEXT, settingsStep: STEP, settingsStepCustomId: '' }),
	);
	assert.equal((item.json.settings as any).maxIterations, 50);
	assert.equal((item.json.settingSources as any).maxIterations, 'agent');
	assert.equal((item.json.settingProblems as string[]).length, 1);
});

// ---------------------------------------------------------------- leases and queue

const lease = (over: Partial<WaitRow>): WaitRow => ({ state: 'running', step_uuid: STEP, agent_uuid: A_TEXT, record_keys: '7', run_id: '1', at: '2026-10-23T09:58:00Z', ...over });
const runOf = (runId: string, over: Record<string, unknown> = {}) => ({ runId, stepUuid: STEP, agentUuid: A_TEXT, agentName: 'Copywriter', recordKeys: ['7'], ...over });

test('checkStart: the oldest live lease wins, a later run is queued, dead leases go', () => {
	const rows = [
		lease({ id: 1, run_id: 'dead', at: '2026-10-23T09:00:00Z' }),
		lease({ id: 2, run_id: 'A', at: '2026-10-23T09:58:00Z' }),
		lease({ id: 3, run_id: 'B', at: '2026-10-23T09:59:00Z' }),
		lease({ id: 4, run_id: 'C', record_keys: '8', at: '2026-10-23T09:59:30Z' }),
		lease({ id: 5, run_id: 'D', agent_uuid: A_VISUAL, at: '2026-10-23T09:57:00Z' }),
	];
	const a = checkStart(rows, runOf('A'), { now: NOW, runTimeoutMinutes: 15 });
	assert.equal(a.start, true);
	assert.deepEqual(a.remove, [1]);

	const b = checkStart(rows, runOf('B', { event: { keys: ['7'], status: 'draft' }, attempt: 2 }), { now: NOW, runTimeoutMinutes: 15 });
	assert.equal(b.start, false);
	assert.equal(b.blockedBy, 'A');
	assert.deepEqual(b.remove.sort(), [1, 3]);
	assert.equal(b.queueRow?.state, 'queued');
	assert.equal(b.queueRow?.run_id, 'A');
	assert.equal(b.queueRow?.attempts, 2);
	assert.deepEqual(JSON.parse(String(b.queueRow?.event)), { keys: ['7'], status: 'draft' });

	assert.equal(checkStart(rows, runOf('C', { recordKeys: ['8'] }), { now: NOW }).start, true, 'other records run in parallel');
});

test('checkStart: same time, lower id wins; no own lease refuses; a dead winner does not block', () => {
	const tie = [lease({ id: 9, run_id: 'X', at: '2026-10-23T09:59:00Z' }), lease({ id: 8, run_id: 'Y', at: '2026-10-23T09:59:00Z' })];
	assert.equal(checkStart(tie, runOf('Y'), { now: NOW }).start, true);
	assert.equal(checkStart(tie, runOf('X'), { now: NOW }).start, false);

	const none = checkStart([lease({ id: 1, run_id: 'other' })], runOf('mine'), { now: NOW });
	assert.equal(none.start, false);
	assert.equal(none.queueRow, null);

	const deadWinner = [lease({ id: 1, run_id: 'old', at: '2026-10-23T09:00:00Z' }), lease({ id: 2, run_id: 'new' })];
	const res = checkStart(deadWinner, runOf('new'), { now: NOW, limitsFor: () => ({ runTimeoutMinutes: 30 }) });
	assert.equal(res.start, true);
	assert.deepEqual(res.remove, [1]);
});

test('planAfterRun: releases its lease and starts the start that was queued meanwhile', () => {
	const rows: WaitRow[] = [
		lease({ id: 1, run_id: 'A' }),
		{ id: 2, state: 'queued', step_uuid: STEP, agent_uuid: A_TEXT, record_keys: '7', run_id: 'A', event: JSON.stringify({ keys: ['7'], n: 1 }), at: '2026-10-23T09:58:30Z' },
		{ id: 3, state: 'queued', step_uuid: STEP, agent_uuid: A_TEXT, record_keys: '7', run_id: 'A', event: JSON.stringify({ keys: ['7'], n: 2 }), at: '2026-10-23T09:59:00Z' },
		{ id: 4, state: 'queued', step_uuid: STEP, agent_uuid: A_TEXT, record_keys: '8', run_id: 'Z', at: '2026-10-23T09:59:00Z' },
	];
	const plan = planAfterRun(rows, { runId: 'A', stepUuid: STEP, agentUuid: A_TEXT, agentName: 'Copywriter', roleUuids: [TEXT], startedAt: '2026-10-23T09:58:00Z', recordKeys: ['7'] }, { now: NOW });
	assert.deepEqual(plan.wake.map((w) => [w.claimId, (w.event as any).n, (w.event.wake as any).wokenBy]), [[3, 2, 'queued while running']]);
	assert.deepEqual(plan.remove.sort(), [1, 2]);
});

test('planAfterRun: keepDoneHours per agent from limitsFor', () => {
	const rows: WaitRow[] = [
		{ id: 1, state: 'done', step_uuid: STEP, agent_uuid: A_VISUAL, roles: VISUAL, record_keys: '9', at: '2026-10-23T07:00:00Z' },
		{ id: 2, state: 'escalated', step_uuid: STEP, agent_uuid: A_VISUAL, record_keys: '9', at: '2026-10-23T07:00:00Z' },
	];
	const run = { runId: 'A', stepUuid: STEP, agentUuid: A_TEXT, roleUuids: [TEXT], startedAt: '2026-10-23T09:58:00Z', recordKeys: ['7'] };
	assert.deepEqual(planAfterRun(rows, run, { now: NOW }).remove, []);
	assert.deepEqual(planAfterRun(rows, run, { now: NOW, limitsFor: (t) => (t.agentUuid === A_VISUAL ? { keepDoneHours: 2 } : {}) }).remove, [1, 2]);
});

test('findStaleWaits: dead leases, orphaned queue, busy agents, escalation only once', () => {
	const rows: WaitRow[] = [
		lease({ id: 1, run_id: 'dead', at: '2026-10-23T09:00:00Z' }),
		{ id: 2, state: 'queued', step_uuid: STEP, agent_uuid: A_TEXT, record_keys: '7', run_id: 'dead', at: '2026-10-23T09:10:00Z' },
		lease({ id: 3, run_id: 'live', agent_uuid: A_VISUAL, record_keys: '8' }),
		{ id: 4, state: 'queued', step_uuid: STEP, agent_uuid: A_VISUAL, record_keys: '8', run_id: 'live', at: '2026-10-23T09:59:00Z' },
		{ id: 5, state: 'waiting', step_uuid: STEP, agent_uuid: A_VISUAL, record_keys: '8', waits_for: TEXT, at: '2026-10-23T07:00:00Z' },
		{ id: 6, state: 'waiting', step_uuid: STEP, agent_uuid: A_VISUAL, record_keys: '5', waits_for: TEXT, attempts: 3, at: '2026-10-23T07:00:00Z' },
		{ id: 7, state: 'waiting', step_uuid: STEP, agent_uuid: A_VISUAL, record_keys: '5', waits_for: TEXT, attempts: 2, at: '2026-10-23T06:00:00Z' },
		{ id: 8, state: 'escalated', step_uuid: STEP, agent_uuid: A_TEXT, record_keys: '1', attempts: 3, at: '2026-10-23T08:00:00Z' },
	];
	const res = findStaleWaits(rows, { now: NOW, runTimeoutMinutes: 15, maxAttempts: 3 });
	assert.deepEqual(res.wake.map((w) => [w.agentUuid, w.claimId, w.attempt]), [[A_TEXT, 2, 1]], 'only the queued start whose run died');
	assert.deepEqual(res.escalate, [6]);
	assert.deepEqual(res.remove.sort(), [1, 7]);
	assert.deepEqual(res.stuck.map((r) => r.id), [6]);
});

test('node: Wait → Check Start and Find Stale use the settings rows', async () => {
	const settingRows = [{ scope: 'agent', target: A_TEXT, key: 'runTimeoutMinutes', value: 120 }];
	const rows = [lease({ id: 1, run_id: 'old', at: '2026-10-23T09:00:00Z' }), lease({ id: 2, run_id: 'new', at: new Date(Date.now() - 1000).toISOString() })];
	rows[0].at = new Date(Date.now() - 60 * 60_000).toISOString();
	const [[blocked]] = await new RoleAlpha().execute.call(ctxFor({ resource: 'wait', operation: 'checkStart', rows, run: runOf('new'), waitOptions: { runTimeoutMinutes: 15 }, settingRows }));
	assert.equal(blocked.json.start, false, 'the agent row lifts the timeout to 120 minutes, so the old run still lives');
	const [[free]] = await new RoleAlpha().execute.call(ctxFor({ resource: 'wait', operation: 'checkStart', rows, run: runOf('new'), waitOptions: { runTimeoutMinutes: 15 }, settingRows: '' }));
	assert.equal(free.json.start, true);
	assert.deepEqual(free.json.remove, [1]);
	await assert.rejects(new RoleAlpha().execute.call(ctxFor({ resource: 'wait', operation: 'checkStart', rows, run: { runId: 'x' }, waitOptions: {} })), /Run needs/);
	const [[stale]] = await new RoleAlpha().execute.call(ctxFor({ resource: 'wait', operation: 'findStale', rows, waitOptions: { runTimeoutMinutes: 15 }, settingRows: '' }));
	assert.deepEqual(stale.json.remove, [1]);
});

// ---------------------------------------------------------------- clipping

test('clipping: reasons, names and events are cut to fixed sizes', () => {
	assert.equal(clip('abc', 5), 'abc');
	assert.equal(clip('abcdef', 3), 'abc …[cut]');
	const huge = 'x'.repeat(MAX_EVENT_CHARS + 10);
	assert.equal(String(parseEvent(huge).text).length, MAX_EVENT_CHARS + ' …[cut]'.length);
	assert.ok(String(parseEvent({ big: huge }).text).endsWith('…[cut]'));
	assert.deepEqual(parseEvent('[1,2]'), { text: '[1,2]' });
	const rows: WaitRow[] = [{ id: 1, state: 'waiting', step_uuid: STEP, agent_uuid: A_VISUAL, agent_name: 'n'.repeat(500), waits_for: TEXT, reason: 'r'.repeat(5000), record_keys: '7', event: JSON.stringify({ keys: ['7'], wake: { attempt: 99 } }), at: '2026-10-23T09:00:00Z' }];
	const plan = planAfterRun(rows, { runId: 'A', stepUuid: STEP, agentUuid: A_TEXT, agentName: 'Copywriter', roleUuids: [TEXT], startedAt: '2026-10-23T09:58:00Z', recordKeys: ['7'] }, { now: NOW });
	const wake = plan.wake[0];
	assert.equal(String((wake.event.wake as any).waitedFor).length, MAX_REASON_CHARS + ' …[cut]'.length);
	assert.equal((wake.event.wake as any).attempt, 1, 'a forged wake in the event is replaced');
	assert.ok(wake.agentName.length < 250);
});

// ---------------------------------------------------------------- share

function shareGraph(): FakeGraph {
	return new FakeGraph(
		{
			[STEP]: { name: 'Content', type: 'Value Creation', customId: 'x:content', data: { subtype: 'subprocess', description: 'Write, design, review.' } },
			[TEXT]: { name: 'Copy', type: 'Roles', data: { subtype: 'role', accountabilities: ['Write texts', 'Set the post to review'] } },
			[VISUAL]: { name: 'Visual', type: 'Roles', data: { subtype: 'role', accountabilities: ['Make visuals'] } },
			[VIDEO]: { name: 'Video', type: 'Roles', data: { subtype: 'role', accountabilities: ['Make videos'] } },
			[REVIEW]: { name: 'Review', type: 'Roles', data: { subtype: 'role', accountabilities: ['Check facts'] } },
			[A_TEXT]: { name: 'Copywriter', type: 'AI Agents', data: { status: 'active' } },
			[A_VISUAL]: { name: 'Designer', type: 'AI Agents', data: { status: 'active' } },
			[PERSON]: { name: 'Pat', type: 'Persons', data: { email: 'pat@example.com' } },
		},
		[
			[TEXT, 'RESPONSIBLE_FOR', STEP],
			[VISUAL, 'RESPONSIBLE_FOR', STEP],
			[VIDEO, 'RESPONSIBLE_FOR', STEP],
			[REVIEW, 'RESPONSIBLE_FOR', STEP],
			[A_TEXT, 'AGENT_FULFILLS_ROLE', TEXT],
			[A_VISUAL, 'AGENT_FULFILLS_ROLE', VISUAL],
			[PERSON, 'EXECUTES', REVIEW],
		],
	);
}

const textBundle: ContextBundle = {
	agent: { uuid: A_TEXT, name: 'Copywriter', status: 'active' },
	guardrails: [],
	context: [{ kind: 'role', uuid: TEXT, name: 'Copy', body: { accountabilities: ['Write texts', 'Set the post to review'] } }],
};

test('share: a hand-over waits only on the deliveries it lists', async () => {
	const step = await getStep(shareGraph(), STEP, { resolveHolders: true, roleDetails: true });
	const input = buildShareInput(textBundle, step, [TEXT]);
	assert.deepEqual(input.others.map((o) => [o.name, o.filled]), [['Visual', true], ['Video', false], ['Review', true]]);
	const res = checkShare(input, {
		duties: [
			{ id: 'A1.1', task: 'Write', handover: false, needs: [] },
			{ id: 'A1.2', task: 'Set review', handover: true, needs: [{ role: 'R1', what: 'visual' }, { role: 'R1', what: 'visual' }] },
		],
		notMine: [],
		reason: '',
	});
	const handover = res.duties.find((d) => d.id === 'A1.2')!;
	assert.equal(handover.handover, true);
	assert.deepEqual(handover.needs.map((n) => n.roleUuid), [VISUAL], 'a filled role that delivers nothing here holds nothing up');
	assert.equal(res.duties.find((d) => d.id === 'A1.1')!.needs.length, 0);
	assert.deepEqual(res.waitRoleUuids, [VISUAL]);
});

test('share: the cache key ignores record data, but not the trigger kind or the roles', async () => {
	const step = await getStep(shareGraph(), STEP, { resolveHolders: true, roleDetails: true });
	const key = (event: unknown) => buildShareInput(textBundle, step, [TEXT], { type: 'event', event }).cacheKey;
	const a = key({ collection: 'posts', status: 'draft', keys: ['7'], payload: { title: 'One' } });
	assert.match(a, /^[0-9a-f]{64}$/);
	assert.equal(a, key({ collection: 'posts', status: 'draft', keys: ['9'], payload: { title: 'Two' } }));
	assert.notEqual(a, key({ collection: 'posts', status: 'review', keys: ['7'] }));
	const noVisualAgent = await getStep(
		new FakeGraph(
			{ ...(shareGraph() as any).entities, [A_VISUAL]: { name: 'Designer', type: 'AI Agents', data: { status: 'inactive' } } },
			(shareGraph() as any).rels,
		),
		STEP,
		{ resolveHolders: true, roleDetails: true },
	);
	assert.notEqual(a, buildShareInput(textBundle, noVisualAgent, [TEXT], { type: 'event', event: { collection: 'posts', status: 'draft' } }).cacheKey);
});

// ---------------------------------------------------------------- circle lead

test('getCircleLeads: flagged lead first, else lead link in purpose, else custom ID, else who decides on the circle', async () => {
	const base = sampleGraph();
	const ent = (base as any).entities;
	const rels = [...(base as any).rels, [CIRCLE, 'IS_IMPLEMENTED_BY', ROLE_LEAD]];

	const flagged = new FakeGraph({ ...ent, [ROLE_LEAD]: { ...ent[ROLE_LEAD], data: { subtype: 'role', leadLink: true } } }, rels);
	const [lead] = await getCircleLeads(flagged, [ROLE_ASSIST, ROLE_DECIDE]);
	assert.equal(lead.circle.uuid, CIRCLE);
	assert.equal(lead.lead?.uuid, ROLE_LEAD);
	assert.equal(lead.basis, 'flag');
	assert.deepEqual(lead.lead?.holders?.persons.map((p) => p.uuid), [PERSON_B]);
	assert.deepEqual(lead.roles.map((r) => r.uuid), [ROLE_ASSIST, ROLE_DECIDE]);

	const byPurpose = new FakeGraph({ ...ent, [ROLE_LEAD]: { ...ent[ROLE_LEAD], data: { subtype: 'role', purpose: 'Acts as Lead Link of the circle' } } }, rels);
	assert.equal((await getCircleLeads(byPurpose, [ROLE_ASSIST]))[0].basis, 'lead-link');

	const byId = new FakeGraph({ ...ent, [ROLE_LEAD]: { ...ent[ROLE_LEAD], customId: 'marketing:lead' } }, rels);
	assert.equal((await getCircleLeads(byId, [ROLE_ASSIST]))[0].lead?.uuid, ROLE_LEAD);

	const deciding = new FakeGraph(ent, [...rels, [ROLE_DECIDE, 'DECIDES_ON', CIRCLE], [PERSON_B, 'DECIDES_ON', CIRCLE]]);
	const d = (await getCircleLeads(deciding, [ROLE_ASSIST]))[0];
	assert.equal(d.basis, 'decides-on-circle');
	assert.equal(d.lead?.uuid, ROLE_DECIDE);

	const none = (await getCircleLeads(base, [ROLE_ASSIST]))[0];
	assert.equal(none.lead, null);
	assert.equal(none.basis, null);
	assert.deepEqual(await getCircleLeads(base, [ROLE_LEAD]), [], 'a role outside any circle');
});
