import type { EntityDetails, GraphSource, Relationship, SearchHit } from '../lib/graph';

/** A small in-memory graph shaped like the roleALPHA MCP answers. */
export interface FakeEntity {
	name: string;
	type: string;
	customId?: string | null;
	data?: Record<string, unknown>;
}

export class FakeGraph implements GraphSource {
	calls: string[] = [];
	constructor(
		private readonly entities: Record<string, FakeEntity>,
		private readonly rels: Array<[string, string, string]>,
		private readonly failOn: Set<string> = new Set(),
	) {}

	async details(uuid: string): Promise<EntityDetails> {
		this.calls.push(`details:${uuid}`);
		if (this.failOn.has(uuid)) throw new Error('backend down');
		const e = this.entities[uuid];
		if (!e) throw new Error(`404 ${uuid}`);
		return { uuid, name: e.name, customId: e.customId ?? null, entityType: e.type, data: e.data ?? {} };
	}

	async relationships(uuid: string): Promise<Relationship[]> {
		this.calls.push(`rels:${uuid}`);
		if (this.failOn.has(uuid)) throw new Error('backend down');
		const out: Relationship[] = [];
		for (const [source, type, target] of this.rels) {
			if (source === uuid) out.push({ type, direction: 'outgoing', uuid: target, name: this.entities[target]?.name ?? '', entityType: this.entities[target]?.type ?? '' });
			if (target === uuid) out.push({ type, direction: 'incoming', uuid: source, name: this.entities[source]?.name ?? '', entityType: this.entities[source]?.type ?? '' });
		}
		return out;
	}

	async search(query: string): Promise<SearchHit[]> {
		return Object.entries(this.entities)
			.filter(([, e]) => (e.customId ?? '').includes(query) || JSON.stringify(e.data ?? {}).includes(query))
			.map(([uuid, e]) => ({ uuid, name: e.name, customId: e.customId ?? null, entityType: e.type }));
	}
}

export const CIRCLE = 'c0000000-0000-4000-8000-000000000001';
export const ROLE_ASSIST = 'r0000000-0000-4000-8000-000000000001';
export const ROLE_DECIDE = 'r0000000-0000-4000-8000-000000000002';
export const ROLE_LEAD = 'r0000000-0000-4000-8000-000000000003';
export const STEP_REVIEW = 's0000000-0000-4000-8000-000000000001';
export const STEP_GATE = 's0000000-0000-4000-8000-000000000002';
export const STEP_SEND = 's0000000-0000-4000-8000-000000000003';
export const STEP_PLAN = 's0000000-0000-4000-8000-000000000004';
export const STEP_ORPHAN = 's0000000-0000-4000-8000-000000000005';
export const PARENT = 's0000000-0000-4000-8000-000000000009';
export const POLICY = 'p0000000-0000-4000-8000-000000000001';
export const PERSON_A = 'u0000000-0000-4000-8000-000000000001';
export const PERSON_B = 'u0000000-0000-4000-8000-000000000002';
export const AGENT = 'a0000000-0000-4000-8000-000000000001';

export function sampleGraph(failOn: string[] = []): FakeGraph {
	return new FakeGraph(
		{
			[CIRCLE]: { name: 'Marketing', type: 'Roles', data: { subtype: 'circle' } },
			[ROLE_ASSIST]: { name: 'Assistant', type: 'Roles', data: { subtype: 'role' } },
			[ROLE_DECIDE]: { name: 'Release Approval', type: 'Roles', data: { subtype: 'role' } },
			[ROLE_LEAD]: { name: 'Lead', type: 'Roles', data: { subtype: 'role' } },
			[STEP_REVIEW]: { name: 'Review', type: 'Value Creation', customId: 'x:review', data: { subtype: 'subprocess', frequency: 'event_driven' } },
			[STEP_GATE]: { name: 'Approval', type: 'Value Creation', customId: 'x:approval', data: { subtype: 'gate', kriterien: 'Human decides', ergebnis: 'offen' } },
			[STEP_SEND]: { name: 'Send', type: 'Value Creation', customId: 'x:send', data: { subtype: 'subprocess' } },
			[STEP_PLAN]: { name: 'Plan', type: 'Value Creation', customId: 'x:plan', data: { subtype: 'subprocess', frequency: 'weekly' } },
			[STEP_ORPHAN]: { name: 'Orphan', type: 'Value Creation', customId: 'x:orphan', data: { subtype: 'subprocess' } },
			[PARENT]: { name: 'Press', type: 'Value Creation', customId: 'x:press', data: { subtype: 'process' } },
			[POLICY]: { name: 'Four eyes', type: 'Policies', customId: 'x:p1', data: { description: 'Only humans approve. See x:approval.', version: '1.0', status: 'approved' } },
			[PERSON_A]: { name: 'Ada', type: 'Persons', data: { email: 'Ada@Example.com', firstName: 'Ada', lastName: 'Lovelace' } },
			[PERSON_B]: { name: 'Bob', type: 'Persons', data: { email: 'bob@example.com', firstName: 'Bob', lastName: 'B' } },
			[AGENT]: { name: 'Assistant', type: 'AI Agents', data: { status: 'active' } },
		},
		[
			[CIRCLE, 'IS_IMPLEMENTED_BY', ROLE_ASSIST],
			[CIRCLE, 'IS_IMPLEMENTED_BY', ROLE_DECIDE],
			[ROLE_ASSIST, 'RESPONSIBLE_FOR', STEP_GATE],
			[ROLE_ASSIST, 'RESPONSIBLE_FOR', STEP_PLAN],
			[ROLE_DECIDE, 'RESPONSIBLE_FOR', STEP_GATE],
			[ROLE_DECIDE, 'DECIDES_ON', STEP_GATE],
			[ROLE_LEAD, 'ACCOUNTABLE_FOR', STEP_GATE],
			[ROLE_LEAD, 'ACCOUNTABLE_FOR', STEP_SEND],
			[POLICY, 'APPLIES_TO', STEP_GATE],
			[STEP_GATE, 'DEPENDS_ON', STEP_REVIEW],
			[STEP_SEND, 'DEPENDS_ON', STEP_GATE],
			[PARENT, 'HAS_SUBPROCESS', STEP_GATE],
			[PERSON_A, 'EXECUTES', ROLE_DECIDE],
			[PERSON_B, 'EXECUTES', ROLE_LEAD],
			[AGENT, 'AGENT_FULFILLS_ROLE', ROLE_ASSIST],
			[AGENT, 'AGENT_FULFILLS_ROLE', ROLE_DECIDE],
		],
		new Set(failOn),
	);
}
