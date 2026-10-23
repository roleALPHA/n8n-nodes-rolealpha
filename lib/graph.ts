/**
 * Traversal of the roleALPHA graph. Nothing here knows a concrete role, person
 * or step: everything is read at run time, starting from an agent or a step.
 *
 * Edge directions (roleALPHA conventions):
 *   Role --RESPONSIBLE_FOR--> Step        Role --DECIDES_ON--> Step
 *   Role --ACCOUNTABLE_FOR--> Step        Policy --APPLIES_TO--> Step
 *   Successor --DEPENDS_ON--> Predecessor Parent --HAS_SUBPROCESS--> Child
 *   Person --EXECUTES--> Role             Agent --AGENT_FULFILLS_ROLE--> Role
 *   Circle --IS_IMPLEMENTED_BY--> Role
 */

import type { McpClient } from './mcp';

export interface EntityDetails {
	uuid: string;
	name: string;
	customId: string | null;
	entityType: string;
	data: Record<string, unknown>;
}

export interface Relationship {
	id?: string | number;
	type: string;
	direction: 'incoming' | 'outgoing';
	uuid: string;
	name: string;
	entityType: string;
}

export interface SearchHit {
	uuid: string;
	name: string;
	customId: string | null;
	entityType: string;
}

export interface GraphSource {
	details(uuid: string): Promise<EntityDetails>;
	relationships(uuid: string): Promise<Relationship[]>;
	search(query: string, entityType?: string): Promise<SearchHit[]>;
}

export interface EntityRef {
	uuid: string;
	name: string;
	entityType?: string;
}

export interface PersonRef extends EntityRef {
	email: string | null;
}

export interface AgentRef extends EntityRef {
	status: string | null;
}

export interface RoleHolders {
	persons: PersonRef[];
	agents: AgentRef[];
}

export interface RoleRef extends EntityRef {
	holders?: RoleHolders;
	purpose?: string | null;
	accountabilities?: string[];
}

export interface StepSummary extends EntityRef {
	customId: string | null;
	subtype: string | null;
	status: string | null;
	frequency: string | null;
	dueDate: string | null;
	description: string | null;
	criteria: string | null;
	result: string | null;
}

export interface Step extends StepSummary {
	predecessors: EntityRef[];
	successors: EntityRef[];
	parents: EntityRef[];
	children: EntityRef[];
	responsibleRoles: RoleRef[];
	decidingRoles: RoleRef[];
	accountableRoles: RoleRef[];
	policies: Array<EntityRef & { description: string | null; version: string | null; status: string | null }>;
}

export interface Duty {
	role: EntityRef;
	circle: EntityRef | null;
	step: StepSummary;
}

export interface Decider {
	basis: 'DECIDES_ON' | 'ACCOUNTABLE_FOR' | null;
	roles: RoleRef[];
}

export interface ApproverCheck {
	allowed: boolean;
	reason: string;
	basis: Decider['basis'];
	role: EntityRef | null;
	person: PersonRef | null;
	candidates: Array<{ role: EntityRef; persons: string[] }>;
}

// ---------------------------------------------------------------- helpers

function obj(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | null {
	if (typeof value === 'string') return value.trim() === '' ? null : value;
	if (typeof value === 'number') return String(value);
	return null;
}

function list(value: unknown, keys: string[]): unknown[] {
	if (Array.isArray(value)) return value;
	const o = obj(value);
	for (const key of keys) if (Array.isArray(o[key])) return o[key] as unknown[];
	return [];
}

export function normalizeEmail(value: unknown): string {
	const raw = typeof value === 'string' ? value : '';
	const bracket = /<([^<>\s]+@[^<>\s]+)>\s*$/.exec(raw);
	return (bracket ? bracket[1] : raw).trim().toLowerCase();
}

export function toDetails(raw: unknown, uuid: string): EntityDetails {
	let o = obj(raw);
	if (o.entity && typeof o.entity === 'object') o = obj(o.entity);
	const data = obj(o.descJsonb ?? o.desc_jsonb ?? o.data);
	return {
		uuid: str(o.uuid) ?? uuid,
		name: str(o.name) ?? '',
		customId: str(o.customerId ?? o.customer_id ?? o.customId),
		entityType: str(o.entityTypeName ?? o.entityType ?? o.type) ?? '',
		data,
	};
}

export function toRelationships(raw: unknown): Relationship[] {
	return list(raw, ['relationships', 'items', 'results'])
		.map(obj)
		.map((r) => ({
			id: (r.relationshipId ?? r.id) as string | number | undefined,
			type: str(r.relationType ?? r.type) ?? '',
			direction: (str(r.direction) === 'incoming' ? 'incoming' : 'outgoing') as Relationship['direction'],
			uuid: str(r.connectedEntityUuid ?? r.entityUuid ?? r.uuid) ?? '',
			name: str(r.connectedEntityName ?? r.name) ?? '',
			entityType: str(r.connectedEntityType ?? r.entityType) ?? '',
		}))
		.filter((r) => r.uuid !== '' && r.type !== '');
}

export function toSearchHits(raw: unknown): SearchHit[] {
	return list(raw, ['results', 'entities', 'items', 'data'])
		.map(obj)
		.map((h) => ({
			uuid: str(h.uuid ?? h.entityUuid ?? h.id) ?? '',
			name: str(h.name) ?? '',
			customId: str(h.customerId ?? h.customer_id ?? h.customId),
			entityType: str(h.entityType ?? h.entityTypeName ?? h.type) ?? '',
		}))
		.filter((h) => h.uuid !== '');
}

function edges(rels: Relationship[], type: string, direction: Relationship['direction']): EntityRef[] {
	const seen = new Set<string>();
	const out: EntityRef[] = [];
	for (const r of rels) {
		if (r.type !== type || r.direction !== direction || seen.has(r.uuid)) continue;
		seen.add(r.uuid);
		out.push({ uuid: r.uuid, name: r.name, entityType: r.entityType });
	}
	return out;
}

function isPersonType(entityType: string): boolean {
	return /person/i.test(entityType);
}

function isAgentType(entityType: string): boolean {
	return /agent/i.test(entityType);
}

export function toStepSummary(d: EntityDetails): StepSummary {
	return {
		uuid: d.uuid,
		name: d.name,
		entityType: d.entityType,
		customId: d.customId,
		subtype: str(d.data.subtype),
		status: str(d.data.status),
		frequency: str(d.data.frequency),
		dueDate: str(d.data.termin ?? d.data.dueDate),
		description: str(d.data.description),
		criteria: str(d.data.kriterien ?? d.data.criteria),
		result: str(d.data.ergebnis ?? d.data.result),
	};
}

// ---------------------------------------------------------------- MCP-backed source

/** Graph source on top of the roleALPHA MCP. Caches per instance (one per node execution). */
export class McpGraphSource implements GraphSource {
	private readonly detailCache = new Map<string, Promise<EntityDetails>>();
	private readonly relCache = new Map<string, Promise<Relationship[]>>();

	constructor(
		private readonly client: McpClient,
		private readonly organisation: string,
	) {}

	details(uuid: string): Promise<EntityDetails> {
		let hit = this.detailCache.get(uuid);
		if (!hit) {
			hit = this.client
				.callTool('get_entity_details', { entityUuid: uuid, organisation: this.organisation })
				.then((raw) => toDetails(raw, uuid));
			this.detailCache.set(uuid, hit);
		}
		return hit;
	}

	relationships(uuid: string): Promise<Relationship[]> {
		let hit = this.relCache.get(uuid);
		if (!hit) {
			hit = this.client
				.callTool('get_entity_relationships', { entityUuid: uuid, organisation: this.organisation })
				.then(toRelationships);
			this.relCache.set(uuid, hit);
		}
		return hit;
	}

	async search(query: string, entityType?: string): Promise<SearchHit[]> {
		const args: Record<string, unknown> = { query, organisation: this.organisation };
		if (entityType) args.entityType = entityType;
		return toSearchHits(await this.client.callTool('search_entities', args));
	}
}

// ---------------------------------------------------------------- traversal

export async function findStepByCustomId(src: GraphSource, customId: string): Promise<StepSummary | null> {
	const wanted = customId.trim();
	if (wanted === '') return null;
	const hits = await src.search(wanted);
	// The search also matches entities that merely mention the ID, so confirm the exact custom ID.
	const candidates = hits.filter((h) => h.customId === null || h.customId === wanted);
	for (const hit of candidates) {
		const d = await src.details(hit.uuid);
		if (d.customId === wanted && (d.entityType === '' || /value creation|process/i.test(d.entityType))) {
			return toStepSummary(d);
		}
	}
	return null;
}

export async function getRoleHolders(src: GraphSource, roleUuid: string): Promise<RoleHolders> {
	const rels = await src.relationships(roleUuid);
	const persons: PersonRef[] = [];
	for (const p of edges(rels, 'EXECUTES', 'incoming').filter((r) => r.entityType === '' || isPersonType(r.entityType!))) {
		const d = await src.details(p.uuid);
		const email = normalizeEmail(d.data.email);
		const name = [str(d.data.firstName), str(d.data.lastName)].filter(Boolean).join(' ') || d.name || p.name;
		persons.push({ uuid: p.uuid, name, email: email === '' ? null : email, entityType: p.entityType });
	}
	const agents: AgentRef[] = [];
	for (const a of edges(rels, 'AGENT_FULFILLS_ROLE', 'incoming').filter((r) => r.entityType === '' || isAgentType(r.entityType!))) {
		const d = await src.details(a.uuid);
		agents.push({ uuid: a.uuid, name: d.name || a.name, status: str(d.data.status), entityType: a.entityType });
	}
	return { persons, agents };
}

export async function getCircle(src: GraphSource, roleUuid: string): Promise<EntityRef | null> {
	const rels = await src.relationships(roleUuid);
	for (const parent of edges(rels, 'IS_IMPLEMENTED_BY', 'incoming')) {
		const d = await src.details(parent.uuid);
		if (str(d.data.subtype) === 'circle') return { uuid: d.uuid, name: d.name, entityType: d.entityType };
	}
	return null;
}

async function withHolders(src: GraphSource, roles: EntityRef[]): Promise<RoleRef[]> {
	const out: RoleRef[] = [];
	for (const role of roles) out.push({ ...role, holders: await getRoleHolders(src, role.uuid) });
	return out;
}

function textList(value: unknown): string[] {
	if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? v.trim() : JSON.stringify(v))).filter(Boolean);
	return typeof value === 'string' && value.trim() !== '' ? [value.trim()] : [];
}

/** Purpose and accountabilities of each role, so every role on a step can see what the others deliver. */
async function withRoleBodies(src: GraphSource, roles: RoleRef[]): Promise<RoleRef[]> {
	const out: RoleRef[] = [];
	for (const role of roles) {
		const d = await src.details(role.uuid);
		out.push({ ...role, purpose: str(d.data.purpose), accountabilities: textList(d.data.accountabilities) });
	}
	return out;
}

export async function getStep(src: GraphSource, stepUuid: string, opts: { resolveHolders?: boolean; roleDetails?: boolean } = {}): Promise<Step> {
	const [d, rels] = await Promise.all([src.details(stepUuid), src.relationships(stepUuid)]);
	const roles = (type: string) => edges(rels, type, 'incoming').filter((r) => !isPersonType(r.entityType ?? ''));
	const policies: Step['policies'] = [];
	for (const p of edges(rels, 'APPLIES_TO', 'incoming')) {
		const pd = await src.details(p.uuid);
		policies.push({
			uuid: p.uuid,
			name: pd.name || p.name,
			entityType: p.entityType,
			description: str(pd.data.description ?? pd.data.body ?? pd.data.text),
			version: str(pd.data.version),
			status: str(pd.data.status),
		});
	}
	let responsibleRoles: RoleRef[] = roles('RESPONSIBLE_FOR');
	let decidingRoles: RoleRef[] = roles('DECIDES_ON');
	let accountableRoles: RoleRef[] = roles('ACCOUNTABLE_FOR');
	if (opts.resolveHolders) {
		responsibleRoles = await withHolders(src, responsibleRoles);
		decidingRoles = await withHolders(src, decidingRoles);
		accountableRoles = await withHolders(src, accountableRoles);
	}
	if (opts.roleDetails) responsibleRoles = await withRoleBodies(src, responsibleRoles);
	return {
		...toStepSummary(d),
		predecessors: edges(rels, 'DEPENDS_ON', 'outgoing'),
		successors: edges(rels, 'DEPENDS_ON', 'incoming'),
		parents: edges(rels, 'HAS_SUBPROCESS', 'incoming'),
		children: edges(rels, 'HAS_SUBPROCESS', 'outgoing'),
		responsibleRoles,
		decidingRoles,
		accountableRoles,
		policies,
	};
}

/** The roles an agent fulfils, read from the graph (used when no context bundle is at hand). */
export async function getAgentRoles(src: GraphSource, agentUuid: string): Promise<EntityRef[]> {
	return edges(await src.relationships(agentUuid), 'AGENT_FULFILLS_ROLE', 'outgoing');
}

/** Every step the given roles are responsible for, one entry per role and step. */
export async function getDuties(src: GraphSource, roleUuids: string[]): Promise<Duty[]> {
	const duties: Duty[] = [];
	for (const roleUuid of Array.from(new Set(roleUuids))) {
		const [role, rels, circle] = await Promise.all([src.details(roleUuid), src.relationships(roleUuid), getCircle(src, roleUuid)]);
		for (const step of edges(rels, 'RESPONSIBLE_FOR', 'outgoing')) {
			const d = await src.details(step.uuid);
			duties.push({ role: { uuid: role.uuid, name: role.name, entityType: role.entityType }, circle, step: toStepSummary(d) });
		}
	}
	return duties;
}

/** Which of the given roles is responsible for the step. Empty means: not responsible. */
export async function responsibleRolesFor(src: GraphSource, stepUuid: string, roleUuids: string[]): Promise<EntityRef[]> {
	const wanted = new Set(roleUuids);
	return edges(await src.relationships(stepUuid), 'RESPONSIBLE_FOR', 'incoming').filter((r) => wanted.has(r.uuid));
}

/** Role first, then person: DECIDES_ON wins; without it the ACCOUNTABLE_FOR role decides. */
export async function getDecider(src: GraphSource, stepUuid: string): Promise<Decider> {
	const rels = await src.relationships(stepUuid);
	const deciding = edges(rels, 'DECIDES_ON', 'incoming').filter((r) => !isPersonType(r.entityType ?? ''));
	if (deciding.length > 0) return { basis: 'DECIDES_ON', roles: await withHolders(src, deciding) };
	const accountable = edges(rels, 'ACCOUNTABLE_FOR', 'incoming').filter((r) => !isPersonType(r.entityType ?? ''));
	if (accountable.length > 0) return { basis: 'ACCOUNTABLE_FOR', roles: await withHolders(src, accountable) };
	return { basis: null, roles: [] };
}

/**
 * Fail-closed check whether the acting person may decide on the step right now.
 * Only persons decide; agents filling the deciding role never count.
 */
export async function checkApprover(src: GraphSource, stepUuid: string, actor: string): Promise<ApproverCheck> {
	const email = normalizeEmail(actor);
	const denied = (reason: string, decider: Decider | null): ApproverCheck => ({
		allowed: false,
		reason,
		basis: decider?.basis ?? null,
		role: null,
		person: null,
		candidates: (decider?.roles ?? []).map((r) => ({
			role: { uuid: r.uuid, name: r.name },
			persons: (r.holders?.persons ?? []).map((p) => p.name),
		})),
	});
	if (email === '' || !email.includes('@')) return denied('No valid address for the acting person', null);
	let decider: Decider;
	try {
		decider = await getDecider(src, stepUuid);
	} catch (error) {
		return denied(`roleALPHA could not be read: ${(error as Error).message}`, null);
	}
	if (decider.roles.length === 0) return denied('No role decides on or is accountable for this step', decider);
	for (const role of decider.roles) {
		const person = (role.holders?.persons ?? []).find((p) => p.email === email);
		if (person) {
			return {
				allowed: true,
				reason: `${role.name} (${decider.basis}) is filled by ${person.name}`,
				basis: decider.basis,
				role: { uuid: role.uuid, name: role.name },
				person,
				candidates: [],
			};
		}
	}
	const filled = decider.roles.some((r) => (r.holders?.persons ?? []).some((p) => p.email));
	return denied(filled ? 'The acting person does not fill the deciding role' : 'Nobody with an address fills the deciding role', decider);
}
