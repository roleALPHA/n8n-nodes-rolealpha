/**
 * Change detection in the roleALPHA graph. roleALPHA's list_changes names the entities that
 * changed effectively since a cursor: approved drafts and every relationship change, fanned out
 * to each end. One call per run replaces reading the whole organisation, so the cost grows with
 * the changes, not with the size of the organisation.
 *
 * What counts: entities a managed workflow is bound to, and entities of the watched types
 * (a new or changed step may need a workflow). What does not: relationships the runner resolves
 * at run time, and on request the access's own writes (who decides, who holds a role, which policy
 * applies). Those never require a workflow to change.
 *
 * A deleted entity does not appear itself; its neighbours get a relationship row whose other
 * end is null. Such a row, a lost cursor or an earlier unreadable check makes the detector ask
 * for every bound entity whether it still exists. Fail-closed: only "not found" counts as removed.
 */

import type { McpClient } from './mcp';

/** Entity types list_changes can filter on and Detect Changes can watch. */
export const ENTITY_TYPES = ['process', 'role', 'agent', 'policy', 'organigramm', 'project', 'okr', 'person'] as const;

/** Relationships the runner reads at run time: a change to them never changes a workflow. */
export const RUNTIME_RELATIONSHIPS = [
	'DECIDES_ON',
	'ACCOUNTABLE_FOR',
	'RESPONSIBLE_FOR',
	'CONSULTED_ON',
	'INFORMED_ON',
	'EXECUTES',
	'AGENT_FULFILLS_ROLE',
	'AGENT_SUPPORTS_PROCESS',
	'AGENT_BOUND_BY_POLICY',
	'IS_IMPLEMENTED_BY',
	'APPLIES_TO',
];

/** Relationships that make a step a neighbour of another: the order and the breakdown of steps. */
export const NEIGHBOUR_RELATIONSHIPS = ['DEPENDS_ON', 'HAS_SUBPROCESS'];

/** One row of list_changes. */
export interface FeedRow {
	entityUuid: string;
	entityType: string;
	changedAt: string;
	change: 'created' | 'updated' | 'deleted' | 'relationship';
	origin?: string;
	ownChange?: boolean;
	via?: {
		relationshipId?: number | string;
		relTypeId?: number;
		relationshipType: string;
		otherEntityUuid: string | null;
		role?: 'from' | 'to' | 'participant';
		action: 'added' | 'changed' | 'removed';
	};
}

export interface RelationshipChange {
	type: string;
	action: 'added' | 'changed' | 'removed';
	/** The other end; null when it was deleted. */
	otherUuid: string | null;
	/** Which end this entity is: from, to or participant. */
	end: string | null;
}

export type ChangeKind = 'created' | 'changed' | 'removed';

/**
 * One entity that changed. It names what changed, not the old values: the model compares the
 * entity as it is now with what the workflows do. Name and custom ID are filled in by Propose.
 */
export interface EntityChange {
	change: ChangeKind;
	uuid: string;
	entityType: string;
	name: string;
	customId: string | null;
	changedAt: string | null;
	relationships: RelationshipChange[];
	/** IDs of the managed workflows bound to this entity. */
	workflows: string[];
}

export interface FeedSummary {
	changes: EntityChange[];
	/** A relationship lost its other end: something was deleted, maybe a bound entity. */
	deletionSeen: boolean;
	skipped: { own: number; runtime: number; unwatched: number };
}

function obj(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function lower(value: unknown): string {
	return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** Rows as list_changes returns them; drops rows without entity or change. */
export function normalizeFeedRows(raw: unknown): FeedRow[] {
	const rows = Array.isArray(raw) ? raw : Array.isArray(obj(raw).changes) ? (obj(raw).changes as unknown[]) : [];
	const out: FeedRow[] = [];
	for (const r of rows.map(obj)) {
		const entityUuid = lower(r.entityUuid);
		const change = String(r.change ?? '');
		if (!entityUuid || !['created', 'updated', 'deleted', 'relationship'].includes(change)) continue;
		const v = obj(r.via);
		const via =
			typeof v.relationshipType === 'string'
				? {
						relationshipId: v.relationshipId as number | string | undefined,
						relTypeId: typeof v.relTypeId === 'number' ? v.relTypeId : undefined,
						relationshipType: v.relationshipType,
						otherEntityUuid: lower(v.otherEntityUuid) || null,
						role: v.role as 'from' | 'to' | 'participant' | undefined,
						action: (['added', 'changed', 'removed'].includes(String(v.action)) ? v.action : 'changed') as 'added' | 'changed' | 'removed',
					}
				: undefined;
		out.push({
			entityUuid,
			entityType: String(r.entityType ?? ''),
			changedAt: String(r.changedAt ?? ''),
			change: change as FeedRow['change'],
			origin: typeof r.origin === 'string' ? r.origin : undefined,
			ownChange: r.ownChange === true,
			via,
		});
	}
	return out;
}

/**
 * Turns feed rows into one change per entity. `bound` maps entity UUIDs to the managed
 * workflows bound to them; `watchTypes` are the types whose new and changed entities count
 * even without a workflow.
 */
export function summarizeFeed(
	rows: FeedRow[],
	opts: { bound: Map<string, string[]>; watchTypes: string[]; ignoreRelationships?: string[]; skipOwn?: boolean },
): FeedSummary {
	const watch = new Set(opts.watchTypes);
	const ignore = new Set(opts.ignoreRelationships ?? RUNTIME_RELATIONSHIPS);
	const skipped = { own: 0, runtime: 0, unwatched: 0 };
	const byUuid = new Map<string, EntityChange>();
	let deletionSeen = false;
	for (const row of rows) {
		// A lost end is checked even when the row itself does not count.
		if (row.change === 'relationship' && row.via && row.via.otherEntityUuid === null) deletionSeen = true;
		// ownChange compares the account: with a personal login it would also drop that person's approvals.
		if (row.ownChange && opts.skipOwn) {
			skipped.own++;
			continue;
		}
		if (!opts.bound.has(row.entityUuid) && !watch.has(row.entityType)) {
			skipped.unwatched++;
			continue;
		}
		if (row.change === 'relationship' && row.via && ignore.has(row.via.relationshipType)) {
			skipped.runtime++;
			continue;
		}
		let c = byUuid.get(row.entityUuid);
		if (!c) {
			c = { change: 'changed', uuid: row.entityUuid, entityType: row.entityType, name: '', customId: null, changedAt: null, relationships: [], workflows: opts.bound.get(row.entityUuid) ?? [] };
			byUuid.set(row.entityUuid, c);
		}
		if (row.change === 'deleted') c.change = 'removed';
		else if (row.change === 'created' && c.change !== 'removed') c.change = 'created';
		if (!c.changedAt || row.changedAt > c.changedAt) c.changedAt = row.changedAt || c.changedAt;
		if (row.change === 'relationship' && row.via) {
			const rel: RelationshipChange = { type: row.via.relationshipType, action: row.via.action, otherUuid: row.via.otherEntityUuid, end: row.via.role ?? null };
			const key = JSON.stringify(rel);
			if (!c.relationships.some((r) => JSON.stringify(r) === key)) c.relationships.push(rel);
		}
	}
	return { changes: [...byUuid.values()], deletionSeen, skipped };
}

// ---------------------------------------------------------------- reading

export interface FeedRead {
	rows: FeedRow[];
	cursor: string;
	/** More rows wait; the next run goes on from `cursor`. */
	hasMore: boolean;
	pages: number;
}

/**
 * Reads list_changes from a cursor, or on the first run from `since`, page by page.
 * A failed call throws, so the stored cursor stays where it was.
 */
export async function readFeed(
	client: McpClient,
	organisation: string,
	start: { cursor?: string; since?: string },
	opts: { maxPages?: number; limit?: number } = {},
): Promise<FeedRead> {
	const maxPages = Math.max(1, opts.maxPages ?? 20);
	const limit = Math.min(500, Math.max(1, opts.limit ?? 500));
	const rows: FeedRow[] = [];
	let cursor = start.cursor ?? '';
	let hasMore = false;
	let pages = 0;
	while (pages < maxPages) {
		const args: Record<string, unknown> = { organisation, limit };
		if (cursor) args.cursor = cursor;
		else if (start.since) args.since = start.since;
		else throw new Error('list_changes needs a cursor or a start time');
		const res = obj(await client.callTool('list_changes', args));
		pages++;
		if (typeof res.nextCursor !== 'string' || res.nextCursor === '') throw new Error('list_changes returned no cursor');
		rows.push(...normalizeFeedRows(res.changes));
		cursor = res.nextCursor;
		hasMore = res.hasMore === true;
		if (!hasMore) break;
	}
	return { rows, cursor, hasMore, pages };
}

export interface ExistenceCheck {
	removed: string[];
	/** Entities whose existence could not be told; checked again next run. */
	unreadable: Array<{ uuid: string; error: string }>;
}

const NOT_FOUND = /not found|nicht gefunden|existiert nicht/i;

/** Asks for every UUID whether it still exists. Only a plain "not found" counts as removed. */
export async function checkExistence(client: McpClient, organisation: string, uuids: string[]): Promise<ExistenceCheck> {
	const removed: string[] = [];
	const unreadable: ExistenceCheck['unreadable'] = [];
	for (const uuid of uuids) {
		try {
			const res = obj(await client.callTool('get_entity_details', { entityUuid: uuid, organisation }));
			const error = typeof res.error === 'string' ? res.error : '';
			if (!error) continue;
			if (NOT_FOUND.test(error)) removed.push(uuid);
			else unreadable.push({ uuid, error: error.slice(0, 300) });
		} catch (error) {
			unreadable.push({ uuid, error: String((error as Error).message ?? error).slice(0, 300) });
		}
	}
	return { removed, unreadable };
}

// ---------------------------------------------------------------- one run

/** What Detect Changes keeps between runs, in the workflow's static data. */
export interface FeedState {
	cursor?: string;
	/** An existence check could not finish; run it again. */
	recheck?: boolean;
}

export interface DetectResult {
	changes: EntityChange[];
	cursor: string;
	hasMore: boolean;
	/** No cursor was stored: the run started at `since` and checked the bound entities. */
	started: boolean;
	/** Bound entities whose existence was checked. */
	checked: number;
	unreadable: ExistenceCheck['unreadable'];
	skipped: FeedSummary['skipped'];
	state: FeedState;
}

export async function detectChanges(
	client: McpClient,
	organisation: string,
	state: FeedState,
	opts: { bound: Map<string, string[]>; watchTypes: string[]; ignoreRelationships?: string[]; skipOwn?: boolean; since?: string; maxPages?: number; now?: Date },
): Promise<DetectResult> {
	const started = !state.cursor;
	const since = opts.since || (opts.now ?? new Date()).toISOString();
	const feed = await readFeed(client, organisation, started ? { since } : { cursor: state.cursor }, { maxPages: opts.maxPages });
	const summary = summarizeFeed(feed.rows, opts);
	const changes = summary.changes;

	let checked = 0;
	let unreadable: ExistenceCheck['unreadable'] = [];
	let recheck = false;
	// Without a cursor nobody knows what happened in between, so the bound entities are checked once.
	if (started || summary.deletionSeen || state.recheck) {
		const known = new Set(changes.filter((c) => c.change === 'removed').map((c) => c.uuid));
		const uuids = [...opts.bound.keys()].filter((u) => !known.has(u)).sort();
		const check = await checkExistence(client, organisation, uuids);
		checked = uuids.length;
		unreadable = check.unreadable;
		recheck = check.unreadable.length > 0;
		for (const uuid of check.removed) {
			const hit = changes.find((c) => c.uuid === uuid);
			if (hit) hit.change = 'removed';
			else changes.push({ change: 'removed', uuid, entityType: '', name: '', customId: null, changedAt: null, relationships: [], workflows: opts.bound.get(uuid) ?? [] });
		}
	}
	return {
		changes,
		cursor: feed.cursor,
		hasMore: feed.hasMore,
		started,
		checked,
		unreadable,
		skipped: summary.skipped,
		state: { cursor: feed.cursor, ...(recheck ? { recheck: true } : {}) },
	};
}

/** Bound entity UUIDs of managed workflows (drafts excluded) to the IDs of those workflows. */
export function boundEntities(workflows: Array<{ id: string; entities: string[]; isDraft: boolean }>): Map<string, string[]> {
	const bound = new Map<string, string[]>();
	for (const w of workflows) {
		if (w.isDraft) continue;
		for (const uuid of w.entities.map(lower).filter(Boolean)) bound.set(uuid, [...(bound.get(uuid) ?? []), w.id]);
	}
	return bound;
}
