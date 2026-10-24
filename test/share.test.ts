import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getStep } from '../lib/graph';
import { buildShareInput, checkShare } from '../lib/share';
import { buildSystemPrompt, buildTask, type ContextBundle } from '../lib/prompt';
import { findStaleWaits, planAfterRun, recordKey, sameRecords, type WaitRow } from '../lib/waits';
import { RoleAlpha } from '../nodes/RoleAlpha/RoleAlpha.node';
import { FakeGraph } from './fixtures';

const STEP = 's1000000-0000-4000-8000-000000000001';
const TEXT = 'r1000000-0000-4000-8000-000000000001';
const VISUAL = 'r1000000-0000-4000-8000-000000000002';
const VIDEO = 'r1000000-0000-4000-8000-000000000003';
const A_TEXT = 'a1000000-0000-4000-8000-000000000001';
const A_VISUAL = 'a1000000-0000-4000-8000-000000000002';
const A_VIDEO = 'a1000000-0000-4000-8000-000000000003';

function contentGraph(): FakeGraph {
	return new FakeGraph(
		{
			[STEP]: { name: 'Content', type: 'Value Creation', customId: 'x:content', data: { subtype: 'subprocess', description: 'Write texts, make visuals and videos, then set status review.' } },
			[TEXT]: { name: 'Copy', type: 'Roles', data: { subtype: 'role', purpose: 'Good texts', accountabilities: ['Write texts per channel', 'Set finished drafts to review'], domains: ['Directus mk_beitraege'] } },
			[VISUAL]: { name: 'Visual Design', type: 'Roles', data: { subtype: 'role', purpose: 'Good visuals', accountabilities: ['Make visuals from templates'] } },
			[VIDEO]: { name: 'Video', type: 'Roles', data: { subtype: 'role', accountabilities: 'Make product videos' } },
			[A_TEXT]: { name: 'Copywriter', type: 'AI Agents', data: { status: 'active' } },
			[A_VISUAL]: { name: 'Designer', type: 'AI Agents', data: { status: 'active' } },
		},
		[
			[TEXT, 'RESPONSIBLE_FOR', STEP],
			[VISUAL, 'RESPONSIBLE_FOR', STEP],
			[VIDEO, 'RESPONSIBLE_FOR', STEP],
			[A_TEXT, 'AGENT_FULFILLS_ROLE', TEXT],
			[A_VISUAL, 'AGENT_FULFILLS_ROLE', VISUAL],
		],
	);
}

const visualBundle: ContextBundle = {
	agent: { uuid: A_VISUAL, name: 'Designer', status: 'active' },
	guardrails: [{ kind: 'policy', uuid: 'p1', name: 'Brand' }],
	context: [{ kind: 'role', uuid: VISUAL, name: 'Visual Design', body: { purpose: 'Good visuals', accountabilities: ['Make visuals from templates'] } }],
};

const textBundle: ContextBundle = {
	agent: { uuid: A_TEXT, name: 'Copywriter', status: 'active' },
	guardrails: [{ kind: 'policy', uuid: 'p1', name: 'Brand' }],
	context: [{ kind: 'role', uuid: TEXT, name: 'Copy', body: { accountabilities: ['Write texts per channel', 'Set finished drafts to review'] } }],
};

test('getStep with roleDetails reads purpose, accountabilities and domains of every responsible role', async () => {
	const step = await getStep(contentGraph(), STEP, { resolveHolders: true, roleDetails: true });
	const byName = Object.fromEntries(step.responsibleRoles.map((r) => [r.name, r]));
	assert.deepEqual(byName['Copy'].accountabilities, ['Write texts per channel', 'Set finished drafts to review']);
	assert.equal(byName['Visual Design'].purpose, 'Good visuals');
	assert.deepEqual(byName['Video'].accountabilities, ['Make product videos']);
	assert.deepEqual(byName['Copy'].domains, ['Directus mk_beitraege']);
	assert.deepEqual(byName['Video'].domains, []);
	assert.equal(byName['Copy'].holders?.agents[0].status, 'active');
	const plain = await getStep(contentGraph(), STEP);
	assert.equal(plain.responsibleRoles[0].accountabilities, undefined);
});

test('buildShareInput lists only own accountabilities and the other roles of the step', async () => {
	const step = await getStep(contentGraph(), STEP, { resolveHolders: true, roleDetails: true });
	const input = buildShareInput(visualBundle, step, [VISUAL], { type: 'event', event: { keys: ['7'] } });
	assert.deepEqual(input.accountabilities.map((a) => [a.id, a.text]), [['A1.1', 'Make visuals from templates']]);
	assert.deepEqual(input.others.map((r) => [r.id, r.name, r.hasActiveAgent]), [
		['R1', 'Copy', true],
		['R2', 'Video', false],
	]);
	assert.match(input.prompt, /R1: Copy\n {2}Purpose: Good texts\n {2}- Write texts per channel/);
	assert.match(input.prompt, /A1\.1 \(Visual Design\): Make visuals from templates/);
	assert.match(input.systemMessage, /needs/);
	assert.throws(() => buildShareInput(visualBundle, step, [TEXT]), /None of the roles/);
});

test('buildShareInput shows the model no record data, so a cached part fits every record', async () => {
	const step = await getStep(contentGraph(), STEP, { resolveHolders: true, roleDetails: true });
	const a = buildShareInput(visualBundle, step, [VISUAL], { type: 'event', event: { collection: 'posts', status: 'draft', keys: ['14'] } });
	const b = buildShareInput(visualBundle, step, [VISUAL], { type: 'event', event: { collection: 'posts', status: 'draft', keys: ['15'] } });
	const c = buildShareInput(visualBundle, step, [VISUAL], { type: 'event', event: { collection: 'posts', status: 'review', keys: ['15'] } });
	assert.equal(a.cacheKey, b.cacheKey);
	assert.equal(a.prompt, b.prompt);
	assert.notEqual(a.cacheKey, c.cacheKey);
	assert.doesNotMatch(a.prompt, /14/);
	assert.match(a.prompt, /Kind of event: \{"collection":"posts","status":"draft"\}/);
});

test('checkShare drops invented duties and roles and collects what to wait for', async () => {
	const step = await getStep(contentGraph(), STEP, { resolveHolders: true, roleDetails: true });
	const input = buildShareInput(visualBundle, step, [VISUAL]);
	const share = checkShare(input, {
		duties: [
			{ id: 'A1.1', task: 'Make the visual for post 7', needs: [{ role: 'R1', what: 'LinkedIn text' }, { role: 'R9', what: 'ghost' }, { role: 'Copy', what: 'headline' }] },
			{ id: 'A1.1', task: 'duplicate', needs: [] },
			{ id: 'A9.9', task: 'Write the text', needs: [] },
		],
		notMine: ['Write texts', 'Set status review'],
		reason: 'ok',
	});
	assert.equal(share.hasShare, true);
	assert.equal(share.duties.length, 1);
	assert.deepEqual(share.duties[0].needs.map((n) => [n.roleUuid, n.what]), [
		[TEXT, 'LinkedIn text'],
		[TEXT, 'headline'],
	]);
	assert.deepEqual(share.waitsFor, [{ uuid: TEXT, name: 'Copy', needs: ['LinkedIn text', 'headline'], hasActiveAgent: true }]);
	assert.deepEqual(share.waitRoleUuids, [TEXT]);
	assert.deepEqual(share.others, ['Copy', 'Video']);

	const none = checkShare(input, { duties: [], notMine: ['all'], reason: 'nothing fits' });
	assert.equal(none.hasShare, false);
	assert.deepEqual(none.waitRoleUuids, [TEXT, VIDEO], 'without predicted needs a wait may refer to every other role');
});

test('the prompt shows the own part, what is not the agent\'s and how to wait', async () => {
	const step = await getStep(contentGraph(), STEP, { resolveHolders: true, roleDetails: true });
	const input = buildShareInput(textBundle, step, [TEXT]);
	const share = checkShare(input, {
		duties: [
			{ id: 'A1.1', task: 'Write the LinkedIn text for post 7', needs: [] },
			{ id: 'A1.2', task: 'Set post 7 to review', needs: [{ role: 'R1', what: 'visual of post 7' }, { role: 'R2', what: 'video of post 7' }] },
		],
		notMine: ['Make visuals', 'Make videos'],
		reason: '',
	});
	const prompt = buildSystemPrompt({ bundle: textBundle, step, share });
	assert.match(prompt, /# Your part of this step\n1\. Write the LinkedIn text for post 7/);
	assert.match(prompt, /Needs first from Visual Design: visual of post 7/);
	assert.match(prompt, /## Not your part \(other roles do it\)\n- Make visuals/);
	assert.match(prompt, /call the tool "wait_for"/);
	const task = buildTask({ step, share, triggerType: 'event' });
	assert.match(task, /^Work now on your part of the step "Content" \(trigger: event\)/);
	assert.match(task, /2\. Set post 7 to review \(needs first: Visual Design: visual of post 7; Video: video of post 7\)/);
	assert.match(task, /then call "wait_for"/);
	assert.doesNotMatch(buildSystemPrompt({ bundle: textBundle, step }), /wait_for/);
	const free = checkShare(input, { duties: [{ id: 'A1.1', task: 'Write the LinkedIn text for post 7', needs: [] }], notMine: [], reason: '' });
	assert.match(buildTask({ step, share: free }), /Your part needs no result of another role\. Do not call "wait_for"/);
});

test('record keys compare as sets; no keys match only no keys', () => {
	assert.equal(recordKey(['7', ' 3', '7']), '3,7');
	assert.equal(recordKey('7,3'), '3,7');
	assert.equal(sameRecords('3,7', ['7']), true);
	assert.equal(sameRecords('', []), true);
	assert.equal(sameRecords('', '7'), false);
	assert.equal(sameRecords('1', '2'), false);
});

const NOW = new Date('2026-10-23T10:00:00Z');
const waitRow = (over: Partial<WaitRow>): WaitRow => ({
	id: 1,
	state: 'waiting',
	step_uuid: STEP,
	step_custom_id: 'x:content',
	agent_uuid: A_VISUAL,
	agent_name: 'Designer',
	waits_for: TEXT,
	reason: 'LinkedIn text missing',
	record_keys: '7',
	event: JSON.stringify({ collection: 'posts', keys: ['7'] }),
	run_id: '100',
	attempts: 0,
	at: '2026-10-23T09:00:00Z',
	...over,
});

test('a finished run wakes the agents of the step that wait on its role', () => {
	const rows = [
		waitRow({ id: 1 }),
		waitRow({ id: 2, agent_uuid: A_VIDEO, agent_name: 'Video', waits_for: TEXT, run_id: '101' }),
		waitRow({ id: 3, agent_uuid: A_VIDEO, agent_name: 'Video', record_keys: '8', run_id: '102' }),
		waitRow({ id: 4, waits_for: VIDEO, agent_uuid: 'a1000000-0000-4000-8000-000000000009', run_id: '103' }),
		waitRow({ id: 5, step_uuid: 's9', run_id: '104' }),
		{ id: 6, state: 'done', step_uuid: STEP, agent_uuid: A_TEXT, roles: TEXT, record_keys: '7', at: '2026-10-22T09:00:00Z' },
		{ id: 7, state: 'done', step_uuid: STEP, agent_uuid: A_VISUAL, roles: VISUAL, record_keys: '7', at: '2026-10-01T09:00:00Z' },
	];
	const plan = planAfterRun(rows, { runId: '200', stepUuid: STEP, agentUuid: A_TEXT, agentName: 'Copywriter', roleUuids: [TEXT], startedAt: '2026-10-23T09:50:00Z', event: { keys: ['7'] } }, { now: NOW });
	assert.equal(plan.waited, false);
	assert.equal(plan.produced, true);
	assert.deepEqual(plan.wake.map((w) => [w.agentName, w.attempt]), [
		['Designer', 1],
		['Video', 1],
	]);
	assert.deepEqual(plan.wake[0].event, { collection: 'posts', keys: ['7'], wake: { attempt: 1, wokenBy: 'Copywriter', wokenByRoles: [TEXT], waitedFor: 'LinkedIn text missing' } });
	assert.deepEqual(plan.wake.map((w) => w.claimId), [1, 2], 'each wake-up claims its wait row');
	assert.deepEqual(plan.remove.sort(), [6, 7], 'the replaced own done row and an expired one');
	assert.equal(plan.doneRow?.state, 'done');
	assert.equal(plan.doneRow?.roles, TEXT);
	assert.equal(plan.doneRow?.record_keys, '7');
});

test('a run that only waited wakes nobody and writes no done row', () => {
	const rows = [waitRow({ id: 1, agent_uuid: A_TEXT, run_id: '300', waits_for: `${VISUAL},${VIDEO}` }), waitRow({ id: 2, waits_for: TEXT, run_id: '99' })];
	const plan = planAfterRun(rows, { runId: '300', stepUuid: STEP, agentUuid: A_TEXT, roleUuids: [TEXT], startedAt: '2026-10-23T09:50:00Z', recordKeys: ['7'] }, { now: NOW });
	assert.equal(plan.waited, true);
	assert.equal(plan.produced, false);
	assert.equal(plan.doneRow, null);
	assert.deepEqual(plan.wake, []);
});

test('a wait after progress still wakes the others', () => {
	const rows = [waitRow({ id: 1, agent_uuid: A_TEXT, run_id: '300', waits_for: VISUAL, progress: 'true' }), waitRow({ id: 2, waits_for: TEXT, run_id: '99' })];
	const plan = planAfterRun(rows, { runId: '300', stepUuid: STEP, agentUuid: A_TEXT, agentName: 'Copywriter', roleUuids: [TEXT], startedAt: '2026-10-23T09:50:00Z', recordKeys: ['7'] }, { now: NOW });
	assert.equal(plan.produced, true);
	assert.deepEqual(plan.wake.map((w) => w.agentUuid), [A_VISUAL]);
	assert.ok(plan.doneRow);
});

test('a result that arrived during the run wakes the waiting agent itself', () => {
	const rows = [
		waitRow({ id: 1, agent_uuid: A_VISUAL, run_id: '400', waits_for: TEXT, attempts: 1 }),
		{ id: 2, state: 'done', step_uuid: STEP, agent_uuid: A_TEXT, roles: TEXT, record_keys: '7', at: '2026-10-23T09:55:00Z' },
	];
	const plan = planAfterRun(rows, { runId: '400', stepUuid: STEP, agentUuid: A_VISUAL, roleUuids: [VISUAL], startedAt: '2026-10-23T09:50:00Z', recordKeys: ['7'] }, { now: NOW });
	assert.deepEqual(plan.wake.map((w) => [w.agentUuid, w.attempt, (w.event.wake as any).wokenBy]), [[A_VISUAL, 2, 'arrived while waiting']]);
	assert.equal(plan.wake[0].claimId, 1);
	assert.deepEqual(plan.remove, []);
	const early = planAfterRun(rows, { runId: '400', stepUuid: STEP, agentUuid: A_VISUAL, roleUuids: [VISUAL], startedAt: '2026-10-23T09:58:00Z', recordKeys: ['7'] }, { now: NOW });
	assert.deepEqual(early.wake, [], 'a result from before the run was already visible to the agent');
});

test('waits at the attempt limit are reported as stuck, not woken', () => {
	const rows = [waitRow({ id: 1, attempts: 5 })];
	const plan = planAfterRun(rows, { runId: '500', stepUuid: STEP, agentUuid: A_TEXT, roleUuids: [TEXT], startedAt: '2026-10-23T09:50:00Z', recordKeys: ['7'] }, { now: NOW });
	assert.deepEqual(plan.wake, []);
	assert.equal(plan.stuck.length, 1);
	assert.ok(!plan.remove.includes(1));
});

test('findStaleWaits restarts old waits once per agent and records', () => {
	const rows = [
		waitRow({ id: 1, at: '2026-10-23T08:00:00Z' }),
		waitRow({ id: 2, at: '2026-10-23T08:30:00Z', attempts: 1 }),
		waitRow({ id: 3, agent_uuid: A_VIDEO, at: '2026-10-23T09:45:00Z' }),
		waitRow({ id: 4, agent_uuid: A_TEXT, at: '2026-10-23T07:00:00Z', attempts: 5 }),
	];
	const res = findStaleWaits(rows, { now: NOW, olderThanMinutes: 60 });
	assert.deepEqual(res.wake.map((w) => [w.agentUuid, w.attempt, w.claimId]), [[A_VISUAL, 2, 2]]);
	assert.deepEqual(res.remove.sort(), [1]);
	assert.deepEqual(res.stuck.map((r) => r.id), [4]);
	assert.deepEqual(res.escalate, [4]);
});

function ctxFor(params: Record<string, unknown>) {
	return {
		getInputData: () => [{ json: {} }],
		getNodeParameter: (name: string, _i: number, fallback?: unknown) => (name in params ? params[name] : fallback),
		getNode: () => ({ name: 'test', type: 'test', typeVersion: 1, position: [0, 0], parameters: {} }),
		continueOnFail: () => false,
	} as any;
}

test('node: Share → Build Input and Check work without a credential', async () => {
	const step = await getStep(contentGraph(), STEP, { resolveHolders: true, roleDetails: true });
	const [[built]] = await new RoleAlpha().execute.call(
		ctxFor({ resource: 'share', operation: 'buildInput', bundle: { bundle: visualBundle }, stepJson: { step }, roles: { roles: [{ uuid: VISUAL }] }, triggerType: 'event', event: '' }),
	);
	assert.equal((built.json.accountabilities as any[]).length, 1);
	assert.ok(built.json.schema);
	const [[checked]] = await new RoleAlpha().execute.call(
		ctxFor({ resource: 'share', operation: 'check', shareInput: built.json, answer: { output: { duties: [{ id: 'A1.1', task: 'Visual', needs: [{ role: 'R1', what: 'text' }] }], notMine: [], reason: '' } } }),
	);
	assert.equal(checked.json.hasShare, true);
	assert.deepEqual(checked.json.waitRoleUuids, [TEXT]);

	const plain = await getStep(contentGraph(), STEP);
	await assert.rejects(
		new RoleAlpha().execute.call(ctxFor({ resource: 'share', operation: 'buildInput', bundle: visualBundle, stepJson: plain })),
		/Role Details/,
	);
});

test('node: Build System Prompt adds the task when a share is given', async () => {
	const step = await getStep(contentGraph(), STEP, { resolveHolders: true, roleDetails: true });
	const share = checkShare(buildShareInput(visualBundle, step, [VISUAL]), { duties: [{ id: 'A1.1', task: 'Make the visual', needs: [] }], notMine: [], reason: '' });
	const [[item]] = await new RoleAlpha().execute.call(ctxFor({ resource: 'prompt', operation: 'buildSystemPrompt', bundle: visualBundle, stepJson: step, share, triggerType: 'event' }));
	assert.match(String(item.json.systemPrompt), /# Your part of this step/);
	assert.match(String(item.json.task), /1\. Make the visual/);
	const [[noShare]] = await new RoleAlpha().execute.call(ctxFor({ resource: 'prompt', operation: 'buildSystemPrompt', bundle: visualBundle, stepJson: step, share: '' }));
	assert.equal(noShare.json.task, undefined);
});

test('node: Wait → Plan After Run ignores empty items and checks the run', async () => {
	const [[plan]] = await new RoleAlpha().execute.call(
		ctxFor({
			resource: 'wait',
			operation: 'planAfterRun',
			rows: [{}, waitRow({ id: 1 })],
			run: { runId: '9', stepUuid: STEP, agentUuid: A_TEXT, agentName: 'Copywriter', roleUuids: [TEXT], startedAt: '2026-10-23T09:50:00Z', recordKeys: ['7'] },
			waitOptions: {},
		}),
	);
	assert.deepEqual((plan.json.wake as any[]).map((w) => w.agentUuid), [A_VISUAL]);
	await assert.rejects(new RoleAlpha().execute.call(ctxFor({ resource: 'wait', operation: 'planAfterRun', rows: [], run: { runId: '9' }, waitOptions: {} })), /Finished Run needs/);
});
