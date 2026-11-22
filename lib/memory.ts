/**
 * Memory of a role. What an agent learns while it does the work of a role belongs to the
 * role, not to the agent: give the role to another agent and the memory goes with it; an
 * agent that loses a role loses its memory. Facts are written without approval, so the
 * checks here decide what may be kept at all.
 *
 * The rows live in a store of the workflow (e.g. an n8n data table); these functions only
 * decide, so the same rules hold wherever the rows are kept. Rows are only ever added:
 *
 *   role_uuid    the role the fact belongs to (one the agent fills when it writes)
 *   step_uuid    '' for the whole role, else the step it was learned on
 *   record_keys  '' unless it concerns certain records of that step
 *   topic        a newer fact on the same role, step, records and topic replaces an older one
 *   fact         the fact; '' forgets the topic
 *   agent_uuid, run_id, at, expires_at   where it came from and until when it counts
 *
 * Safety rules:
 * - Only roles the agent fills in this run, read from its bundle; never one named by the model alone.
 * - Who decides, who fills a role and which rule applies is read from roleALPHA on every run and
 *   never kept here. Persons filling the step's roles, e-mail addresses, UUIDs, phone numbers and
 *   secrets are refused; each company adds its own terms (e.g. customer names) and patterns.
 * - Memory goes into the prompt as data with its date, never as instructions, and within fixed sizes.
 */

import type { Step } from './graph';
import type { BundleItem, ContextBundle } from './prompt';
import { recordKey, sameRecords } from './waits';
import { isNormative, locatePages, ownCircles, type CircleInfo, type KnowledgeEntry, type KnowledgeOptions, type PageRef } from './knowledge';

/** Name of the tool an agent calls to keep a fact for its role. */
export const REMEMBER_TOOL = 'remember';
export const MAX_FACT_CHARS = 500;
export const MAX_TOPIC_CHARS = 80;

/** step and records are kept as rows; role as rows, or as the role's page with knowledge pages on; circle only as the circle's page. */
export type MemoryScope = 'role' | 'step' | 'records' | 'circle';

export interface MemoryRow {
	id?: number | string;
	role_uuid: string;
	step_uuid?: string | null;
	record_keys?: string | null;
	topic?: string | null;
	fact?: string | null;
	agent_uuid?: string | null;
	run_id?: string | null;
	at?: string | null;
	expires_at?: string | null;
	createdAt?: string | null;
}

export interface MemoryLimits {
	/** Facts that go into one prompt. */
	maxFacts?: number;
	/** Characters of all facts in one prompt. */
	maxChars?: number;
	/** Days a fact counts after it was written. */
	ttlDays?: number;
	/** Facts kept per role in the store (Consolidate). */
	keepFacts?: number;
}

/** What each company decides for itself: its n8n, its rules. */
export interface MemoryPolicy {
	blockEmails?: boolean;
	blockUuids?: boolean;
	blockPhoneNumbers?: boolean;
	/** Names of the persons who fill the roles of the step (from Get Step with holders). */
	blockPersonNames?: boolean;
	/** Words that may never be kept, e.g. customer names. Whole words, any case. */
	blockedTerms?: string[];
	/** Regular expressions that may never match, e.g. an IBAN. */
	blockedPatterns?: string[];
}

export const DEFAULT_MEMORY_POLICY: Required<Omit<MemoryPolicy, 'blockedTerms' | 'blockedPatterns'>> = {
	blockEmails: true,
	blockUuids: true,
	blockPhoneNumbers: true,
	blockPersonNames: true,
};

export interface RememberRequest {
	fact?: unknown;
	/** Role name or UUID; may be left out when the agent has one role on the step (or one role at all). */
	role?: unknown;
	scope?: unknown;
	topic?: unknown;
	/** Forget the topic instead of keeping a fact. */
	forget?: unknown;
}

export interface WriteContext {
	bundle: ContextBundle;
	step?: Pick<Step, 'uuid'> & Partial<Pick<Step, 'responsibleRoles' | 'decidingRoles' | 'accountableRoles'>> | null;
	recordKeys?: unknown;
	runId?: string | null;
	now?: Date;
	ttlDays?: number;
	policy?: MemoryPolicy;
	/** Knowledge pages: lasting facts of a role or circle go to its page instead of a row. */
	knowledge?: { enabled: boolean; circles?: CircleInfo[] | null; opts?: KnowledgeOptions } | null;
}

export type WriteResult =
	| { ok: true; target: 'rows'; row: MemoryRow; replaces: string }
	| { ok: true; target: 'page'; page: PageRef; entry: KnowledgeEntry }
	| { ok: false; error: string; problems: string[] };

export interface MemoryFact {
	id: number | string | null;
	role: string;
	roleUuid: string;
	scope: MemoryScope;
	topic: string;
	fact: string;
	at: string | null;
}

export interface SelectResult {
	memory: MemoryFact[];
	/** Facts that counted but did not fit into the limits. */
	omitted: number;
}

export interface ConsolidateResult {
	/** Row ids to delete: expired, replaced, forgotten, of roles that are gone, beyond the limit per role. */
	remove: Array<number | string>;
	kept: number;
	byRole: Record<string, number>;
}

export const DEFAULT_MEMORY_LIMITS: Required<MemoryLimits> = { maxFacts: 30, maxChars: 4000, ttlDays: 180, keepFacts: 200 };

const DAY = 86_400_000;
const lower = (v: unknown) => String(v ?? '').trim().toLowerCase();

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** International numbers (+43 …, 0043 …) and local ones with an area code (0664 1234567). */
const PHONE = /(?:\+|\b00)\d[\d\s/().-]{6,}\d|\b0\d{2,4}[\s/-]?\d{4,}\b/;
/** Secrets are refused everywhere; this is not configurable. */
const SECRETS: RegExp[] = [
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
	/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/,
	/\bgh[pousr]_[A-Za-z0-9]{20,}/,
	/\bxox[abpr]-[A-Za-z0-9-]{10,}/,
	/\bagt_[A-Za-z0-9]{10,}/,
	/\bAKIA[0-9A-Z]{16}\b/,
	/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
	/\b(?:passwor[dt]|kennwort|secret|api[_-]?key|token)\s*[:=]\s*\S+/i,
];

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A term as a whole word, in any case unless asked otherwise, also with umlauts and other letters. */
function wordPattern(term: string, caseSensitive = false): RegExp {
	return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term)}(?![\\p{L}\\p{N}])`, caseSensitive ? 'u' : 'iu');
}

/** Checks the patterns of a policy once, so a broken one is reported before anything is written. */
export function compilePatterns(patterns: string[] | undefined): RegExp[] {
	return (patterns ?? [])
		.map((p) => p.trim())
		.filter(Boolean)
		.map((p) => {
			try {
				return new RegExp(p, 'iu');
			} catch (error) {
				throw new Error(`Blocked pattern "${p}" is not a valid regular expression: ${(error as Error).message}`);
			}
		});
}

/** The roles the agent fills itself; circles and roles reached through other links do not count. */
export function ownRoles(bundle: ContextBundle): BundleItem[] {
	return (bundle.context ?? []).filter((c) => {
		if (c.kind !== 'role') return false;
		const rel = c.provenance?.relType;
		if (rel) return rel === 'AGENT_FULFILLS_ROLE';
		return lower(c.body?.subtype) !== 'circle';
	});
}

function personNames(step: WriteContext['step']): string[] {
	if (!step) return [];
	const roles = [...(step.responsibleRoles ?? []), ...(step.decidingRoles ?? []), ...(step.accountableRoles ?? [])];
	const names = roles.flatMap((r) => (r.holders?.persons ?? []).map((p) => String(p.name ?? '').trim()));
	return Array.from(new Set(names.filter((n) => n.length >= 3)));
}

/** Why a fact may not be kept; empty when it may. */
export function factProblems(fact: string, policy: MemoryPolicy = {}, step: WriteContext['step'] = null): string[] {
	const p = { ...DEFAULT_MEMORY_POLICY, ...policy };
	const problems: string[] = [];
	if (SECRETS.some((r) => r.test(fact))) problems.push('it looks like a secret (key, token or password)');
	if (p.blockEmails && EMAIL.test(fact)) problems.push('it contains an e-mail address');
	if (p.blockUuids && UUID_ANYWHERE.test(fact)) problems.push('it contains a UUID');
	if (p.blockPhoneNumbers && PHONE.test(fact)) problems.push('it contains a phone number');
	if (p.blockPersonNames) {
		// The full name in any case, and each part as written, so "Ada" is caught as well as
		// "ada lovelace", while a first name like "Max" does not refuse "max. 5 per day".
		for (const name of personNames(step)) {
			const parts = name.split(/\s+/).filter((w) => w.length >= 3);
			if (wordPattern(name).test(fact) || parts.some((w) => wordPattern(w, true).test(fact))) {
				problems.push('it names a person who fills a role of this step; who does what is read from roleALPHA on every run');
				break;
			}
		}
	}
	for (const term of (p.blockedTerms ?? []).map((t) => t.trim()).filter(Boolean)) {
		if (wordPattern(term).test(fact)) {
			problems.push('it contains a term this company does not keep in memory');
			break;
		}
	}
	for (const re of compilePatterns(p.blockedPatterns)) {
		if (re.test(fact)) {
			problems.push('it matches a pattern this company does not keep in memory');
			break;
		}
	}
	return problems;
}

/** A stable topic: given by the model, else the fact itself, so the same fact twice is kept once. */
export function topicOf(topic: unknown, fact: string): string {
	const raw = String(topic ?? '').trim() || fact;
	return raw
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim()
		.slice(0, MAX_TOPIC_CHARS)
		.trim();
}

function refuse(error: string, problems: string[] = []): WriteResult {
	return { ok: false, error, problems };
}

/** Checks a remember call and returns the row to add. The model gives fact, role, scope and topic; everything else comes from the run. */
export function checkWrite(request: RememberRequest, ctx: WriteContext): WriteResult {
	const now = ctx.now ?? new Date();
	const roles = ownRoles(ctx.bundle);
	if (roles.length === 0) return refuse('The agent fills no role in this run, so there is nothing to remember for.');
	const pages = !!ctx.knowledge?.enabled;
	const scope = (lower(request.scope) || 'role') as MemoryScope;
	const scopes: MemoryScope[] = pages ? ['role', 'circle', 'step', 'records'] : ['role', 'step', 'records'];
	if (!scopes.includes(scope)) return refuse(`Scope is one of ${scopes.join(', ')}.`);
	const wanted = lower(request.role);

	// A circle: named by UUID or name, or as one of the agent's roles in it, else the only circle of its roles.
	if (scope === 'circle') {
		const circles = ownCircles(ctx.bundle, ctx.knowledge?.circles);
		if (circles.length === 0) return refuse('None of your roles is in a circle known to this run; use scope role.');
		let circle = wanted ? circles.find((c) => c.uuid === wanted || lower(c.name) === wanted || c.roles.some((r) => r === wanted || lower(roles.find((x) => lower(x.uuid) === r)?.name) === wanted)) : undefined;
		if (wanted && !circle) return refuse(`"${String(request.role)}" is not a circle of your roles. Use one of: ${circles.map((c) => c.name).join(', ')}.`);
		if (!circle) {
			if (circles.length !== 1) return refuse(`Name the circle the fact belongs to: ${circles.map((c) => c.name).join(', ')}.`);
			circle = circles[0];
		}
		const ref = locatePages(ctx.bundle, ctx.knowledge?.circles, ctx.knowledge?.opts).find((r) => r.entity === 'circle' && r.uuid === circle!.uuid);
		if (!ref) return refuse('The page of this circle could not be found.');
		return pageEntry(request, ref, ctx, now);
	}

	// The role: named by UUID or name, else the only own role on the step, else the only own role.
	let role: BundleItem | undefined;
	if (wanted) {
		role = roles.find((r) => lower(r.uuid) === wanted || lower(r.name) === wanted);
		if (!role) return refuse(`"${String(request.role)}" is not a role this agent fills. Use one of: ${roles.map((r) => r.name).join(', ')}.`);
	} else {
		const onStep = ctx.step?.responsibleRoles ? roles.filter((r) => ctx.step!.responsibleRoles!.some((s) => lower(s.uuid) === lower(r.uuid))) : [];
		const candidates = onStep.length ? onStep : roles;
		if (candidates.length !== 1) return refuse(`Name the role the fact belongs to: ${candidates.map((r) => r.name).join(', ')}.`);
		role = candidates[0];
	}

	if (scope === 'role' && pages) {
		const ref = locatePages(ctx.bundle, ctx.knowledge?.circles, ctx.knowledge?.opts).find((r) => r.entity === 'role' && r.uuid === lower(role!.uuid));
		if (!ref) return refuse('The page of this role could not be found.');
		return pageEntry(request, ref, ctx, now);
	}
	const stepUuid = lower(ctx.step?.uuid);
	const records = recordKey(ctx.recordKeys);
	if (scope !== 'role' && !stepUuid) return refuse(`Scope "${scope}" needs a step; this run has none. Use scope role.`);
	if (scope === 'records' && !records) return refuse('Scope "records" needs records; this run has none. Use scope step or role.');

	const forget = request.forget === true || lower(request.forget) === 'true';
	const fact = forget ? '' : String(request.fact ?? '').replace(/\s+/g, ' ').trim();
	if (!forget && !fact) return refuse('Give the fact to remember, or set forget with the topic.');
	if (fact.length > MAX_FACT_CHARS) return refuse(`The fact has ${fact.length} characters; keep it under ${MAX_FACT_CHARS}, one fact per call.`);
	const topic = topicOf(request.topic, fact);
	if (!topic) return refuse('Give a topic for what to forget.');

	const problems = factProblems(`${fact} ${String(request.topic ?? '')}`, ctx.policy, ctx.step);
	if (problems.length) return refuse(`Not kept: ${problems.join('; ')}.`, problems);

	const ttlDays = ctx.ttlDays ?? DEFAULT_MEMORY_LIMITS.ttlDays;
	const row: MemoryRow = {
		role_uuid: lower(role.uuid),
		step_uuid: scope === 'role' ? '' : stepUuid,
		record_keys: scope === 'records' ? records : '',
		topic,
		fact,
		agent_uuid: lower(ctx.bundle.agent?.uuid),
		run_id: ctx.runId ?? '',
		at: now.toISOString(),
		expires_at: new Date(now.getTime() + ttlDays * DAY).toISOString(),
	};
	return { ok: true, target: 'rows', row, replaces: groupKey(row) };
}

/** The checks for a fact that goes to the page of a role or circle. */
function pageEntry(request: RememberRequest, ref: PageRef, ctx: WriteContext, now: Date): WriteResult {
	const forget = request.forget === true || lower(request.forget) === 'true';
	const fact = forget ? '' : String(request.fact ?? '').replace(/\s+/g, ' ').trim();
	if (!forget && !fact) return refuse('Give the fact to remember, or set forget with the topic.');
	if (fact.length > MAX_FACT_CHARS) return refuse(`The fact has ${fact.length} characters; keep it under ${MAX_FACT_CHARS}, one fact per call.`);
	const topic = topicOf(request.topic, fact);
	if (!topic) return refuse('Give a topic for what to forget.');
	const problems = factProblems(`${fact} ${String(request.topic ?? '')}`, ctx.policy, ctx.step);
	if (problems.length) return refuse(`Not kept: ${problems.join('; ')}.`, problems);
	const terms = ctx.knowledge?.opts?.normativeTerms;
	return {
		ok: true,
		target: 'page',
		page: ref,
		entry: {
			text: fact,
			topic,
			at: now.toISOString(),
			run: ctx.runId ?? '',
			agent: lower(ctx.bundle.agent?.uuid),
			forget,
			normative: !forget && isNormative(fact, terms && terms.length ? terms : undefined),
		},
	};
}

function timeOf(row: MemoryRow): number {
	const t = Date.parse(String(row.at ?? row.createdAt ?? ''));
	return Number.isFinite(t) ? t : 0;
}

function newestFirst(a: MemoryRow, b: MemoryRow): number {
	const d = timeOf(b) - timeOf(a);
	if (d !== 0) return d;
	const na = Number(a.id);
	const nb = Number(b.id);
	return Number.isFinite(na) && Number.isFinite(nb) ? nb - na : String(b.id ?? '').localeCompare(String(a.id ?? ''));
}

function groupKey(row: MemoryRow): string {
	return [lower(row.role_uuid), lower(row.step_uuid), recordKey(row.record_keys), lower(row.topic) || topicOf('', String(row.fact ?? ''))].join('|');
}

function expired(row: MemoryRow, now: number, ttlDays: number): boolean {
	const until = Date.parse(String(row.expires_at ?? ''));
	if (Number.isFinite(until) && until <= now) return true;
	const at = timeOf(row);
	// A shorter lifetime in the settings counts for rows written before it.
	return at > 0 && at + ttlDays * DAY <= now;
}

/** The newest row of each topic; a forgotten topic (empty fact) drops out. */
function current(rows: MemoryRow[]): { latest: MemoryRow[]; replaced: MemoryRow[]; forgotten: MemoryRow[] } {
	const groups = new Map<string, MemoryRow[]>();
	for (const r of rows) {
		const k = groupKey(r);
		groups.set(k, [...(groups.get(k) ?? []), r]);
	}
	const latest: MemoryRow[] = [];
	const replaced: MemoryRow[] = [];
	const forgotten: MemoryRow[] = [];
	for (const list of groups.values()) {
		const [first, ...rest] = [...list].sort(newestFirst);
		replaced.push(...rest);
		if (String(first.fact ?? '').trim()) latest.push(first);
		else forgotten.push(first);
	}
	return { latest, replaced, forgotten };
}

function usable(rows: unknown): MemoryRow[] {
	return (Array.isArray(rows) ? rows : []).filter((r): r is MemoryRow => !!r && typeof r === 'object' && !!(r as MemoryRow).role_uuid);
}

/** What goes into the prompt: facts of the roles the agent fills now, on this step and these records, newest and closest first. */
export function selectMemory(
	rowsIn: unknown,
	ctx: { bundle: ContextBundle; stepUuid?: string | null; recordKeys?: unknown; now?: Date; limits?: MemoryLimits },
): SelectResult {
	const limits = { ...DEFAULT_MEMORY_LIMITS, ...ctx.limits };
	const now = (ctx.now ?? new Date()).getTime();
	const roles = new Map(ownRoles(ctx.bundle).map((r) => [lower(r.uuid), r.name]));
	const step = lower(ctx.stepUuid);
	const records = recordKey(ctx.recordKeys);

	const relevant = usable(rowsIn).filter((r) => {
		if (!roles.has(lower(r.role_uuid))) return false;
		const rowStep = lower(r.step_uuid);
		if (rowStep && rowStep !== step) return false;
		const rowRecords = recordKey(r.record_keys);
		if (rowRecords && (!records || !sameRecords(rowRecords, records))) return false;
		return true;
	});
	const { latest } = current(relevant);
	const live = latest.filter((r) => !expired(r, now, limits.ttlDays));

	const rank = (r: MemoryRow) => (recordKey(r.record_keys) ? 0 : lower(r.step_uuid) ? 1 : 2);
	live.sort((a, b) => rank(a) - rank(b) || newestFirst(a, b));

	const memory: MemoryFact[] = [];
	let chars = 0;
	for (const r of live) {
		const fact = String(r.fact ?? '').trim().slice(0, MAX_FACT_CHARS);
		if (memory.length >= limits.maxFacts || chars + fact.length > limits.maxChars) continue;
		chars += fact.length;
		memory.push({
			id: r.id ?? null,
			role: roles.get(lower(r.role_uuid)) ?? '',
			roleUuid: lower(r.role_uuid),
			scope: recordKey(r.record_keys) ? 'records' : lower(r.step_uuid) ? 'step' : 'role',
			topic: lower(r.topic),
			fact,
			at: r.at ?? r.createdAt ?? null,
		});
	}
	return { memory, omitted: live.length - memory.length };
}

/** For a scheduler: which rows to delete, so the store stays small and holds only what still counts. */
export function consolidateMemory(rowsIn: unknown, opts: { now?: Date; limits?: MemoryLimits; knownRoleUuids?: string[] | null } = {}): ConsolidateResult {
	const limits = { ...DEFAULT_MEMORY_LIMITS, ...opts.limits };
	const now = (opts.now ?? new Date()).getTime();
	const known = opts.knownRoleUuids && opts.knownRoleUuids.length ? new Set(opts.knownRoleUuids.map(lower)) : null;
	const rows = usable(rowsIn);
	const remove = new Set<number | string>();
	const drop = (r: MemoryRow) => r.id !== undefined && r.id !== null && r.id !== '' && remove.add(r.id);

	const { latest, replaced, forgotten } = current(rows);
	replaced.forEach(drop);
	forgotten.forEach(drop);

	const byRole: Record<string, MemoryRow[]> = {};
	for (const r of latest) {
		const role = lower(r.role_uuid);
		if (expired(r, now, limits.ttlDays) || (known && !known.has(role))) {
			drop(r);
			continue;
		}
		(byRole[role] ??= []).push(r);
	}
	const counts: Record<string, number> = {};
	let kept = 0;
	for (const [role, list] of Object.entries(byRole)) {
		list.sort(newestFirst);
		list.slice(limits.keepFacts).forEach(drop);
		counts[role] = Math.min(list.length, limits.keepFacts);
		kept += counts[role];
	}
	return { remove: Array.from(remove), kept, byRole: counts };
}
