/**
 * Change detection in the roleALPHA graph. roleALPHA sends no event when a step, role or
 * agent is created or changed, so a scheduler takes a snapshot and compares it with the
 * rows it stored the last time.
 *
 * Fail-closed: an entity that could not be read is neither new nor changed nor removed;
 * its old row stays. Removals are reported only when the complete index was read.
 * An entity that could not be read in the first run gets a pending row, so that it is
 * taken in silently later instead of being reported as new.
 */

import { createHash } from 'crypto';
import { canonicalJson } from './seal';
import type { GraphSource, Relationship } from './graph';
import type { McpClient, Sleep } from './mcp';

/** Fingerprint of a row for an entity that existed in the first run but could not be read. */
export const PENDING = 'pending';

/** Entity types of the lean index (list_entities). */
export const ENTITY_TYPES = ['process', 'role', 'agent', 'policy', 'organigramm', 'project', 'okr', 'person'] as const;

export interface IndexEntry {
	uuid: string;
	name: string;
	entityType: string;
}

export interface EntitySnapshot {
	uuid: string;
	name: string;
	/** Type of the lean index (process, role, agent, …). */
	entityType: string;
	customId: string | null;
	/** Short hash per attribute, so a change names the attributes that changed. */
	fields: Record<string, string>;
	/** `TYPE>uuid` (outgoing) and `TYPE<uuid` (incoming), sorted. */
	edges: string[];
	fingerprint: string;
}

/** A stored snapshot row. `fields` and `edges` are JSON strings so any table can hold them. */
export interface SnapshotRow {
	uuid: string;
	entity_type: string;
	name: string;
	custom_id: string | null;
	fingerprint: string;
	fields: string;
	edges: string;
	seen_at: string;
}

export type ChangeKind = 'created' | 'changed' | 'removed';

export interface EntityChange {
	change: ChangeKind;
	uuid: string;
	name: string;
	entityType: string;
	customId: string | null;
	previousName: string | null;
	changedFields: string[];
	edgesAdded: string[];
	edgesRemoved: string[];
}

export interface DetectResult {
	/** No stored rows yet: the snapshot is stored and nothing is reported. */
	baseline: boolean;
	/** Whether the complete index was read; only then are removals reported. */
	complete: boolean;
	changes: EntityChange[];
	/** Rows to insert or replace (by uuid). */
	upsert: SnapshotRow[];
	/** UUIDs whose rows are deleted. */
	remove: string[];
	/** Entities that could not be read this time; their rows stay as they are. */
	unreadable: Array<{ uuid: string; name: string; entityType?: string; error: string }>;
}

function hash(value: unknown, length = 16): string {
	return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex').slice(0, length);
}

/** Attributes that change without the entity changing in substance. */
const VOLATILE = /^(updated_?at|updatedAt|modified_?at|last_?(seen|run|login)(_?at)?|version_?count|views?)$/i;

export function snapshotOf(
	entry: IndexEntry,
	details: { name: string; customId: string | null; data: Record<string, unknown> },
	rels: Relationship[],
): EntitySnapshot {
	const fields: Record<string, string> = {};
	for (const [key, value] of Object.entries(details.data ?? {})) {
		if (value === undefined || VOLATILE.test(key)) continue;
		fields[key] = hash(value, 12);
	}
	const edges = [...new Set(rels.map((r) => `${r.type}${r.direction === 'outgoing' ? '>' : '<'}${r.uuid}`))].sort();
	const name = details.name || entry.name;
	return {
		uuid: entry.uuid,
		name,
		entityType: entry.entityType,
		customId: details.customId,
		fields,
		edges,
		fingerprint: hash({ name, customId: details.customId, fields, edges }),
	};
}

export function toRow(s: EntitySnapshot, seenAt: string): SnapshotRow {
	return {
		uuid: s.uuid,
		entity_type: s.entityType,
		name: s.name,
		custom_id: s.customId,
		fingerprint: s.fingerprint,
		fields: JSON.stringify(s.fields),
		edges: JSON.stringify(s.edges),
		seen_at: seenAt,
	};
}

function parseJson<T>(value: unknown, fallback: T): T {
	if (value && typeof value === 'object') return value as T;
	if (typeof value !== 'string' || value.trim() === '') return fallback;
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

/** Rows as they come back from a table: drops rows without uuid or fingerprint. */
export function normalizeRows(raw: unknown): SnapshotRow[] {
	return (Array.isArray(raw) ? raw : [])
		.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
		.filter((r) => typeof r.uuid === 'string' && r.uuid !== '' && typeof r.fingerprint === 'string')
		.map((r) => ({
			uuid: String(r.uuid).toLowerCase(),
			entity_type: String(r.entity_type ?? ''),
			name: String(r.name ?? ''),
			custom_id: typeof r.custom_id === 'string' && r.custom_id !== '' ? r.custom_id : null,
			fingerprint: String(r.fingerprint),
			fields: typeof r.fields === 'string' ? r.fields : JSON.stringify(r.fields ?? {}),
			edges: typeof r.edges === 'string' ? r.edges : JSON.stringify(r.edges ?? []),
			seen_at: String(r.seen_at ?? ''),
		}));
}

export function detectChanges(
	previousRaw: unknown,
	current: EntitySnapshot[],
	opts: { complete: boolean; types: string[]; unreadable?: DetectResult['unreadable']; now?: Date; reportBaseline?: boolean },
): DetectResult {
	const now = (opts.now ?? new Date()).toISOString();
	const types = new Set(opts.types);
	// Rows of other types belong to another detector with another type filter; leave them alone.
	const previous = normalizeRows(previousRaw).filter((r) => types.has(r.entity_type));
	const unreadable = opts.unreadable ?? [];
	const baseline = previous.length === 0 && !opts.reportBaseline;
	const before = new Map(previous.map((r) => [r.uuid, r]));
	const seen = new Set<string>([...current.map((c) => c.uuid), ...unreadable.map((u) => u.uuid.toLowerCase())]);

	const changes: EntityChange[] = [];
	const upsert: SnapshotRow[] = [];
	for (const snap of current) {
		const old = before.get(snap.uuid);
		if (old && old.fingerprint === snap.fingerprint) continue;
		upsert.push(toRow(snap, now));
		// Part of the first run, only read now: its first snapshot, not a change.
		if (baseline || old?.fingerprint === PENDING) continue;
		if (!old) {
			changes.push({ change: 'created', uuid: snap.uuid, name: snap.name, entityType: snap.entityType, customId: snap.customId, previousName: null, changedFields: [], edgesAdded: snap.edges, edgesRemoved: [] });
			continue;
		}
		const oldFields = parseJson<Record<string, string>>(old.fields, {});
		const oldEdges = new Set(parseJson<string[]>(old.edges, []));
		const newEdges = new Set(snap.edges);
		const changedFields = [...new Set([...Object.keys(oldFields), ...Object.keys(snap.fields)])].filter((k) => oldFields[k] !== snap.fields[k]).sort();
		if (old.name !== snap.name) changedFields.unshift('name');
		if ((old.custom_id ?? null) !== snap.customId) changedFields.unshift('customId');
		changes.push({
			change: 'changed',
			uuid: snap.uuid,
			name: snap.name,
			entityType: snap.entityType,
			customId: snap.customId,
			previousName: old.name !== snap.name ? old.name : null,
			changedFields,
			edgesAdded: snap.edges.filter((e) => !oldEdges.has(e)),
			edgesRemoved: [...oldEdges].filter((e) => !newEdges.has(e)).sort(),
		});
	}

	if (baseline) {
		for (const u of unreadable) {
			const uuid = u.uuid.toLowerCase();
			if (before.has(uuid)) continue;
			if (!u.entityType || !types.has(u.entityType)) continue;
			upsert.push({ uuid, entity_type: u.entityType, name: u.name, custom_id: null, fingerprint: PENDING, fields: '{}', edges: '[]', seen_at: now });
		}
	}

	const remove: string[] = [];
	if (opts.complete) {
		for (const old of previous) {
			if (seen.has(old.uuid)) continue;
			remove.push(old.uuid);
			if (!baseline) {
				changes.push({ change: 'removed', uuid: old.uuid, name: old.name, entityType: old.entity_type, customId: old.custom_id, previousName: null, changedFields: [], edgesAdded: [], edgesRemoved: parseJson<string[]>(old.edges, []) });
			}
		}
	}
	return { baseline, complete: opts.complete, changes, upsert, remove, unreadable };
}

// ---------------------------------------------------------------- reading

function obj(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Reads the complete lean index of one type, page by page. */
export async function listIndex(client: McpClient, organisation: string, entityType: string, maxPages = 20): Promise<IndexEntry[]> {
	const out: IndexEntry[] = [];
	let offset = 0;
	for (let page = 0; page < maxPages; page++) {
		const res = obj(await client.callTool('list_entities', { organisation, entityType, offset }));
		const rows = Array.isArray(res.entities) ? res.entities : [];
		for (const raw of rows.map(obj)) {
			const uuid = typeof raw.uuid === 'string' ? raw.uuid.toLowerCase() : '';
			if (uuid) out.push({ uuid, name: String(raw.name ?? ''), entityType });
		}
		if (res.hasMore !== true || rows.length === 0) return out;
		offset = typeof res.nextOffset === 'number' ? res.nextOffset : offset + rows.length;
	}
	throw new Error(`The index of "${entityType}" has more than ${maxPages} pages; narrow the entity types`);
}

/** Runs `fn` over `items` with at most `limit` calls at a time. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i]);
		}
	});
	await Promise.all(workers);
	return out;
}

export interface SnapshotRead {
	snapshots: EntitySnapshot[];
	unreadable: DetectResult['unreadable'];
}

/**
 * Reads details and relationships of every index entry. Entries the server turned away
 * (e.g. rate limit) are read once more one by one after a pause; what still fails is
 * marked unreadable.
 */
export async function readSnapshots(
	src: GraphSource,
	entries: IndexEntry[],
	concurrency = 2,
	opts: { pauseMs?: number; sleep?: Sleep } = {},
): Promise<SnapshotRead> {
	const snapshots: EntitySnapshot[] = [];
	const failed: Array<{ entry: IndexEntry; error: unknown }> = [];
	const read = async (entry: IndexEntry) => {
		const [details, rels] = await Promise.all([src.details(entry.uuid), src.relationships(entry.uuid)]);
		snapshots.push(snapshotOf(entry, details, rels));
	};
	await pool(entries, concurrency, async (entry) => {
		try {
			await read(entry);
		} catch (error) {
			failed.push({ entry, error });
		}
	});
	const unreadable: DetectResult['unreadable'] = [];
	if (failed.length > 0) {
		await (opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(opts.pauseMs ?? 10_000);
		for (const { entry } of failed) {
			try {
				await read(entry);
			} catch (error) {
				unreadable.push({ uuid: entry.uuid, name: entry.name, entityType: entry.entityType, error: String((error as Error).message ?? error).slice(0, 300) });
			}
		}
	}
	snapshots.sort((a, b) => a.uuid.localeCompare(b.uuid));
	return { snapshots, unreadable };
}
