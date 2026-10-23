import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	checkApprover,
	findStepByCustomId,
	getAgentRoles,
	getDecider,
	getDuties,
	getStep,
	normalizeEmail,
	responsibleRolesFor,
	toRelationships,
	toDetails,
} from '../lib/graph';
import { AGENT, CIRCLE, PARENT, PERSON_A, POLICY, ROLE_ASSIST, ROLE_DECIDE, ROLE_LEAD, STEP_GATE, STEP_ORPHAN, STEP_PLAN, STEP_REVIEW, STEP_SEND, sampleGraph } from './fixtures';

test('normalizeEmail reads "Name <address>" and lowercases', () => {
	assert.equal(normalizeEmail('Ada Lovelace <Ada@Example.com>'), 'ada@example.com');
	assert.equal(normalizeEmail('  BOB@example.com '), 'bob@example.com');
	assert.equal(normalizeEmail(undefined), '');
});

test('toRelationships and toDetails map MCP shapes', () => {
	const rels = toRelationships({
		relationships: [
			{ relationshipId: 1, relationType: 'EXECUTES', direction: 'incoming', connectedEntityUuid: 'u1', connectedEntityName: 'Ada', connectedEntityType: 'Persons' },
			{ relationType: 'X', direction: 'outgoing' },
		],
	});
	assert.deepEqual(rels, [{ id: 1, type: 'EXECUTES', direction: 'incoming', uuid: 'u1', name: 'Ada', entityType: 'Persons' }]);
	const d = toDetails({ uuid: 's1', name: 'Gate', customerId: 'x:gate', descJsonb: { subtype: 'gate' }, entityTypeName: 'Value Creation' }, 's1');
	assert.equal(d.customId, 'x:gate');
	assert.equal(d.data.subtype, 'gate');
});

test('findStepByCustomId ignores policies that only mention the ID', async () => {
	const g = sampleGraph();
	const step = await findStepByCustomId(g, 'x:approval');
	assert.equal(step?.uuid, STEP_GATE);
	assert.equal(step?.criteria, 'Human decides');
	assert.equal(await findStepByCustomId(g, 'x:nothing'), null);
	assert.equal(await findStepByCustomId(g, 'x:p1'), null, 'a policy is not a step');
});

test('getStep reads neighbours with the documented directions', async () => {
	const step = await getStep(sampleGraph(), STEP_GATE, { resolveHolders: true });
	assert.deepEqual(step.predecessors.map((s) => s.uuid), [STEP_REVIEW]);
	assert.deepEqual(step.successors.map((s) => s.uuid), [STEP_SEND]);
	assert.deepEqual(step.parents.map((s) => s.uuid), [PARENT]);
	assert.deepEqual(step.responsibleRoles.map((r) => r.uuid).sort(), [ROLE_ASSIST, ROLE_DECIDE].sort());
	assert.deepEqual(step.decidingRoles.map((r) => r.uuid), [ROLE_DECIDE]);
	assert.deepEqual(step.accountableRoles.map((r) => r.uuid), [ROLE_LEAD]);
	assert.deepEqual(step.policies.map((p) => [p.uuid, p.version]), [[POLICY, '1.0']]);
	assert.equal(step.decidingRoles[0].holders?.persons[0].email, 'ada@example.com');
	assert.equal(step.decidingRoles[0].holders?.agents[0].uuid, AGENT);
});

test('getDuties lists every step per role with its circle', async () => {
	const g = sampleGraph();
	const roles = await getAgentRoles(g, AGENT);
	assert.deepEqual(roles.map((r) => r.uuid).sort(), [ROLE_ASSIST, ROLE_DECIDE].sort());
	const duties = await getDuties(g, [ROLE_ASSIST, ROLE_ASSIST]);
	assert.deepEqual(duties.map((d) => d.step.uuid).sort(), [STEP_GATE, STEP_PLAN].sort());
	assert.equal(duties[0].circle?.uuid, CIRCLE);
	assert.equal(duties.find((d) => d.step.uuid === STEP_PLAN)?.step.frequency, 'weekly');
});

test('responsibleRolesFor is empty when the agent is not responsible', async () => {
	const g = sampleGraph();
	assert.equal((await responsibleRolesFor(g, STEP_GATE, [ROLE_ASSIST])).length, 1);
	assert.equal((await responsibleRolesFor(g, STEP_SEND, [ROLE_ASSIST])).length, 0);
});

test('getDecider: DECIDES_ON first, else ACCOUNTABLE_FOR, else nobody', async () => {
	const g = sampleGraph();
	const gate = await getDecider(g, STEP_GATE);
	assert.equal(gate.basis, 'DECIDES_ON');
	assert.deepEqual(gate.roles.map((r) => r.uuid), [ROLE_DECIDE]);
	const send = await getDecider(g, STEP_SEND);
	assert.equal(send.basis, 'ACCOUNTABLE_FOR');
	assert.deepEqual(send.roles.map((r) => r.uuid), [ROLE_LEAD]);
	assert.deepEqual(await getDecider(g, STEP_ORPHAN), { basis: null, roles: [] });
});

test('checkApprover allows only a person filling the deciding role', async () => {
	const g = sampleGraph();
	const ok = await checkApprover(g, STEP_GATE, 'Ada Lovelace <ada@example.com>');
	assert.equal(ok.allowed, true);
	assert.equal(ok.role?.uuid, ROLE_DECIDE);
	assert.equal(ok.person?.uuid, PERSON_A);

	const accountableOnly = await checkApprover(g, STEP_GATE, 'bob@example.com');
	assert.equal(accountableOnly.allowed, false, 'DECIDES_ON overrides ACCOUNTABLE_FOR');
	assert.deepEqual(accountableOnly.candidates.map((c) => c.persons), [['Ada Lovelace']]);

	assert.equal((await checkApprover(g, STEP_SEND, 'bob@example.com')).allowed, true);
	assert.equal((await checkApprover(g, STEP_ORPHAN, 'ada@example.com')).allowed, false);
	assert.equal((await checkApprover(g, STEP_GATE, '')).allowed, false);
	assert.equal((await checkApprover(g, STEP_GATE, 'not-an-address')).allowed, false);
});

test('checkApprover fails closed when roleALPHA cannot be read', async () => {
	const res = await checkApprover(sampleGraph([STEP_GATE]), STEP_GATE, 'ada@example.com');
	assert.equal(res.allowed, false);
	assert.match(res.reason, /could not be read/);
});
