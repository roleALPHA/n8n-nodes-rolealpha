/**
 * The share of one agent in a process step. A step can hold many tasks, several roles
 * share it, and their parts can depend on each other within the step. Only the
 * accountabilities of the agent's own roles can make a task the agent's part; what the
 * part needs first comes from the other roles responsible for the same step.
 *
 * The model call itself stays outside: buildShareInput prepares it, checkShare checks
 * the answer against the roleALPHA data, so the model can neither add duties nor invent roles.
 */

import { createHash } from 'crypto';
import type { RoleRef, Step } from './graph';
import type { ContextBundle } from './prompt';

export interface ShareTrigger {
	type?: string;
	event?: unknown;
}

export interface ShareAccountability {
	id: string;
	roleUuid: string;
	role: string;
	text: string;
}

export interface ShareOtherRole {
	id: string;
	uuid: string;
	name: string;
	/** Whether an active agent fills the role; only then does its finished run wake the waiting agents. */
	hasActiveAgent: boolean;
	/** Whether anybody (active agent or person) fills the role. */
	filled: boolean;
}

export interface ShareInput {
	stepUuid: string;
	stepName: string;
	stepCustomId: string | null;
	roles: Array<{ uuid: string; name: string }>;
	others: ShareOtherRole[];
	accountabilities: ShareAccountability[];
	systemMessage: string;
	prompt: string;
	/**
	 * Same key, same decision: hash of the rules, the step, the roles and the kind of trigger,
	 * without record data. A cached answer is still checked again by checkShare.
	 */
	cacheKey: string;
}

export interface ShareNeed {
	roleUuid: string;
	role: string;
	what: string;
	/** Where the result is found (collection, field, status), so a check can see it is there. */
	where: string;
}

export interface ShareDuty {
	id: string;
	roleUuid: string;
	role: string;
	accountability: string;
	task: string;
	/** The duty closes the step (hand-over, status change for the next step): it is done last, after its needs. */
	handover: boolean;
	needs: ShareNeed[];
}

export interface ShareWait {
	uuid: string;
	name: string;
	needs: string[];
	hasActiveAgent: boolean;
}

export interface ShareResult {
	stepUuid: string;
	stepName: string;
	stepCustomId: string | null;
	hasShare: boolean;
	roles: Array<{ uuid: string; name: string }>;
	duties: ShareDuty[];
	notMine: string[];
	others: string[];
	waitsFor: ShareWait[];
	/** Role UUIDs a wait of this agent refers to: the predicted needs, else every other role of the step. */
	waitRoleUuids: string[];
	reason: string;
}

export const SHARE_SYSTEM_MESSAGE = [
	'A process step can hold many tasks, and several roles share it. Decide which part of this step belongs to the roles of one agent, and what that part needs from the other roles of the same step.',
	'1. Only an accountability listed under "Accountabilities of the agent\'s roles" can make a task the agent\'s part. The role purpose is context only and adds no task.',
	'2. Pick each accountability that this step calls for in this run (step description, criteria, result and trigger). For each, write in "task" concretely what the agent does now in this step under exactly that accountability, and nothing beyond it.',
	'3. In "needs", list for each duty the deliveries of other roles of this step that must exist before the agent can do that task: the role id (R…), in "what" exactly which result, and in "where" where it is found (collection, field or status). A delivery is a result that the step description or an accountability of that role names, that is stored in data where it can be checked, and without which the task cannot be done, for example the text a visual illustrates, or a decision the step requires before the hand-over. Informing people, asking for feedback, recording or answering questions is no delivery and never a need. Leave "needs" empty when the task can start right away.',
	'4. List in "notMine" every task of the step that none of the listed accountabilities covers.',
	'5. Never stretch an accountability to cover a task it does not name. If none fits, return an empty "duties" list.',
	'6. Use only the ids from the input. Write "task", "what", "notMine" and "reason" in the language of the step. Describe tasks without record ids, names or contents: the same part applies to every record of this kind of trigger.',
	'7. Set "handover" to true for a duty that closes the step for the next one, e.g. handing results on or setting the status for the next step. Such a duty is done last. It waits only on the deliveries listed in its "needs", never on a role that delivers nothing in this step.',
].join('\n');

/** Raise when the rules or the input format change, so cached decisions are not reused. */
export const SHARE_VERSION = 'share-5';

/** Event fields that change the share decision; record data (ids, texts) does not. */
const EVENT_KIND_FIELDS = ['collection', 'status', 'event', 'action', 'type'];

/** JSON schema of the model answer, for a structured output parser. */
export const SHARE_SCHEMA = {
	type: 'object',
	properties: {
		duties: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					id: { type: 'string', description: 'Id of the accountability, e.g. A1.2' },
					task: { type: 'string', description: 'What the agent does now in this step under this accountability' },
					handover: { type: 'boolean', description: 'True when this duty closes the step for the next one (hand-over, status for the next step)' },
					needs: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								role: { type: 'string', description: 'Id of another role of this step, e.g. R1' },
								what: { type: 'string', description: 'The delivery of that role this task needs first' },
								where: { type: 'string', description: 'Where the delivery is found: collection, field or status' },
							},
							required: ['role', 'what', 'where'],
						},
					},
				},
				required: ['id', 'task', 'handover', 'needs'],
			},
		},
		notMine: { type: 'array', items: { type: 'string' } },
		reason: { type: 'string' },
	},
	required: ['duties', 'notMine', 'reason'],
};

function text(value: unknown): string {
	if (value === null || value === undefined) return '';
	if (typeof value === 'string') return value.trim();
	return JSON.stringify(value);
}

function textList(value: unknown): string[] {
	if (Array.isArray(value)) return value.map(text).filter(Boolean);
	const single = text(value);
	return single ? [single] : [];
}

const lower = (v: unknown) => String(v ?? '').trim().toLowerCase();

function hasActiveAgent(role: RoleRef): boolean {
	return (role.holders?.agents ?? []).some((a) => lower(a.status) === 'active');
}

/**
 * Prepares the model call. myRoleUuids are the agent's roles that are responsible for
 * the step (Check Responsibility); without them the roles of the bundle on the step count.
 */
export function buildShareInput(bundle: ContextBundle, step: Step, myRoleUuids: string[], trigger: ShareTrigger = {}): ShareInput {
	const onStep = new Set(step.responsibleRoles.map((r) => lower(r.uuid)));
	const wanted = new Set((myRoleUuids.length ? myRoleUuids : Array.from(onStep)).map(lower));
	const roles = (bundle.context ?? []).filter((c) => c.kind === 'role' && wanted.has(lower(c.uuid)) && onStep.has(lower(c.uuid)));
	if (roles.length === 0) throw new Error(`None of the roles of agent ${bundle.agent?.name ?? ''} is responsible for step ${step.name}`);
	const mine = new Set(roles.map((r) => lower(r.uuid)));

	const accountabilities: ShareAccountability[] = [];
	roles.forEach((r, ri) => {
		textList(r.body?.accountabilities).forEach((t, ai) => accountabilities.push({ id: `A${ri + 1}.${ai + 1}`, roleUuid: lower(r.uuid), role: r.name, text: t }));
	});
	const otherRoles = step.responsibleRoles.filter((r) => !mine.has(lower(r.uuid)));
	const others: ShareOtherRole[] = otherRoles.map((r, n) => ({
		id: `R${n + 1}`,
		uuid: lower(r.uuid),
		name: r.name,
		hasActiveAgent: hasActiveAgent(r),
		filled: hasActiveAgent(r) || (r.holders?.persons ?? []).length > 0,
	}));

	const lines = ['# Step', `${step.name}${step.customId ? ` [${step.customId}]` : ''}`, `Description: ${step.description || '-'}`];
	if (step.criteria) lines.push(`Criteria: ${step.criteria}`);
	if (step.result) lines.push(`Result: ${step.result}`);

	lines.push('', '# Other roles responsible for this step (id: name)');
	if (otherRoles.length === 0) lines.push('none');
	otherRoles.forEach((r, n) => {
		lines.push(`${others[n].id}: ${r.name}`);
		if (r.purpose) lines.push(`  Purpose: ${r.purpose}`);
		for (const a of r.accountabilities ?? []) lines.push(`  - ${a}`);
	});

	lines.push('', "# Roles of the agent on this step");
	for (const r of roles) {
		const purpose = text(r.body?.purpose);
		lines.push(`- ${r.name}${purpose ? ` (purpose, context only): ${purpose}` : ''}`);
	}
	lines.push('', "# Accountabilities of the agent's roles (id (role): text)");
	if (accountabilities.length === 0) lines.push('none');
	for (const a of accountabilities) lines.push(`${a.id} (${a.role}): ${a.text}`);

	// The decision is cached per kind of trigger and reused for every record, so the model sees no record data either.
	const kind = eventKind(trigger.event);
	lines.push('', '# Trigger', `Type: ${trigger.type || 'manual'}`);
	if (Object.keys(kind).length) lines.push(`Kind of event: ${JSON.stringify(kind)}`);
	const cacheKey = createHash('sha256')
		.update(JSON.stringify([SHARE_VERSION, SHARE_SYSTEM_MESSAGE, lines.join('\n'), others.map((o) => [o.uuid, o.hasActiveAgent, o.filled])]))
		.digest('hex');

	return {
		stepUuid: lower(step.uuid),
		stepName: step.name,
		stepCustomId: step.customId,
		roles: roles.map((r) => ({ uuid: lower(r.uuid), name: r.name })),
		others,
		accountabilities,
		systemMessage: SHARE_SYSTEM_MESSAGE,
		prompt: lines.join('\n'),
		cacheKey,
	};
}

/** The kind of trigger without record data, e.g. {collection, status}. */
function eventKind(event: unknown): Record<string, string> {
	const e = (event && typeof event === 'object' && !Array.isArray(event) ? event : {}) as Record<string, unknown>;
	const out: Record<string, string> = {};
	for (const k of EVENT_KIND_FIELDS) {
		const v = e[k];
		if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = String(v).slice(0, 200);
	}
	return out;
}

/** Keeps only duties of real accountabilities and needs on real other roles of the step. */
export function checkShare(input: ShareInput, answer: unknown): ShareResult {
	const out = (answer && typeof answer === 'object' ? answer : {}) as Record<string, unknown>;
	const byId = new Map(input.accountabilities.map((a) => [a.id, a]));
	const roleById = new Map(input.others.map((r) => [r.id, r]));
	const roleByName = new Map(input.others.map((r) => [lower(r.name), r]));
	const seen = new Set<string>();
	const duties: ShareDuty[] = [];
	for (const raw of Array.isArray(out.duties) ? out.duties : []) {
		const d = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
		const id = text(d.id);
		const acc = byId.get(id);
		if (!acc || seen.has(id)) continue;
		seen.add(id);
		const needs: ShareNeed[] = [];
		for (const rawNeed of Array.isArray(d.needs) ? d.needs : []) {
			const n = (rawNeed && typeof rawNeed === 'object' ? rawNeed : {}) as Record<string, unknown>;
			const role = roleById.get(text(n.role)) ?? roleByName.get(lower(n.role));
			const what = text(n.what);
			if (role && what && !needs.some((x) => x.roleUuid === role.uuid && x.what === what)) needs.push({ roleUuid: role.uuid, role: role.name, what: what.slice(0, 500), where: text(n.where).slice(0, 300) });
		}
		// A hand-over waits only on the deliveries it lists: a role that delivers nothing here holds nothing up.
		const handover = d.handover === true || text(d.handover).toLowerCase() === 'true';
		duties.push({ id, roleUuid: acc.roleUuid, role: acc.role, accountability: acc.text, task: (text(d.task) || acc.text).slice(0, 2000), handover, needs });
	}

	const waits = new Map<string, ShareWait>();
	for (const n of duties.flatMap((d) => d.needs)) {
		const role = input.others.find((r) => r.uuid === n.roleUuid)!;
		const w = waits.get(n.roleUuid) ?? { uuid: n.roleUuid, name: n.role, needs: [], hasActiveAgent: role.hasActiveAgent };
		if (!w.needs.includes(n.what)) w.needs.push(n.what);
		waits.set(n.roleUuid, w);
	}

	return {
		stepUuid: input.stepUuid,
		stepName: input.stepName,
		stepCustomId: input.stepCustomId,
		hasShare: duties.length > 0,
		roles: input.roles,
		duties,
		notMine: textList(out.notMine).slice(0, 50).map((t) => t.slice(0, 500)),
		others: input.others.map((r) => r.name),
		waitsFor: Array.from(waits.values()),
		waitRoleUuids: waits.size ? Array.from(waits.keys()) : input.others.map((r) => r.uuid),
		reason: text(out.reason).slice(0, 2000),
	};
}
