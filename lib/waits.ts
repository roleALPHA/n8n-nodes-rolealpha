/**
 * Waiting within a step. Parts of one step can depend on each other: an agent whose part
 * needs the result of another role does what it can, records a wait and ends. When a run
 * of another role of the same step ends with a result, the waiting agents are started again.
 *
 * The rows live in a store of the workflow (e.g. an n8n data table); these functions only
 * decide, so the same rules hold wherever the rows are kept.
 *
 *   state "waiting": agent_uuid waits on step_uuid for the roles in waits_for (empty = any other role)
 *   state "done":    a run of agent_uuid with the roles in roles ended with a result at "at"
 */

export interface WaitRow {
	id?: number | string;
	state: string;
	step_uuid: string;
	step_custom_id?: string | null;
	agent_uuid: string;
	agent_name?: string | null;
	roles?: string | null;
	waits_for?: string | null;
	reason?: string | null;
	record_keys?: string | null;
	event?: string | null;
	run_id?: string | null;
	attempts?: number | string | null;
	progress?: boolean | string | null;
	at?: string | null;
	createdAt?: string | null;
}

export interface FinishedRun {
	runId: string;
	stepUuid: string;
	stepCustomId?: string | null;
	agentUuid: string;
	agentName?: string | null;
	roleUuids: string[];
	recordKeys?: unknown;
	startedAt: string;
	event?: unknown;
	/** 0 for a first run, n for the n-th wake-up. */
	attempt?: number;
}

export interface WakeUp {
	agentUuid: string;
	agentName: string;
	stepUuid: string;
	stepCustomId: string;
	attempt: number;
	event: Record<string, unknown>;
}

export interface AfterRunPlan {
	/** The agent recorded a wait in this run. */
	waited: boolean;
	/** The run produced a result (no wait, or a wait after progress); only then are others woken. */
	produced: boolean;
	/** Row to add for this run, or null. */
	doneRow: WaitRow | null;
	wake: WakeUp[];
	/** Row ids to delete: answered waits and replaced or expired done rows. */
	remove: Array<number | string>;
	/** Waits that reached the attempt limit; they stay until a person or the scheduler looks at them. */
	stuck: WaitRow[];
}

export interface WaitOptions {
	maxAttempts?: number;
	keepDoneHours?: number;
	now?: Date;
}

const lower = (v: unknown) => String(v ?? '').trim().toLowerCase();

export function uuidSet(value: unknown): string[] {
	const raw = Array.isArray(value) ? value : String(value ?? '').split(',');
	return Array.from(new Set(raw.map(lower).filter(Boolean)));
}

/** Record keys of an event as one stable text, e.g. "12,7" → "12,7" sorted. */
export function recordKey(keys: unknown): string {
	const raw = Array.isArray(keys) ? keys : keys === undefined || keys === null || keys === '' ? [] : String(keys).split(',');
	return Array.from(new Set(raw.map((k) => String(k).trim()).filter(Boolean))).sort().join(',');
}

/** Two runs concern the same records when both have none or they share one. */
export function sameRecords(a: unknown, b: unknown): boolean {
	const ka = recordKey(a);
	const kb = recordKey(b);
	if (ka === '' || kb === '') return ka === kb;
	const set = new Set(ka.split(','));
	return kb.split(',').some((k) => set.has(k));
}

function truthy(v: unknown): boolean {
	return v === true || lower(v) === 'true' || v === 1 || v === '1';
}

function attemptsOf(row: WaitRow): number {
	const n = Number(row.attempts);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function timeOf(row: WaitRow): number {
	const t = Date.parse(String(row.at ?? row.createdAt ?? ''));
	return Number.isFinite(t) ? t : 0;
}

function parseEvent(value: unknown): Record<string, unknown> {
	if (value && typeof value === 'object' && !Array.isArray(value)) return { ...(value as Record<string, unknown>) };
	if (typeof value === 'string' && value.trim()) {
		try {
			const parsed = JSON.parse(value);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
		} catch {
			/* keep as text */
		}
		return { text: value };
	}
	return {};
}

function waitsOn(row: WaitRow, roleUuids: string[]): boolean {
	const wanted = uuidSet(row.waits_for);
	return wanted.length === 0 || wanted.some((r) => roleUuids.includes(r));
}

function wakeFor(row: WaitRow, by: { agentName: string; roles: string[] }): WakeUp {
	const attempt = attemptsOf(row) + 1;
	const event = parseEvent(row.event);
	event.wake = { attempt, wokenBy: by.agentName, wokenByRoles: by.roles, waitedFor: row.reason ?? '' };
	return {
		agentUuid: lower(row.agent_uuid),
		agentName: String(row.agent_name ?? ''),
		stepUuid: lower(row.step_uuid),
		stepCustomId: String(row.step_custom_id ?? ''),
		attempt,
		event,
	};
}

/** The newest waiting row per agent and records; older duplicates are removed with it. */
function groupWaits(rows: WaitRow[]): Array<{ row: WaitRow; ids: Array<number | string> }> {
	const groups = new Map<string, { row: WaitRow; ids: Array<number | string> }>();
	for (const row of rows) {
		const key = `${lower(row.agent_uuid)}|${recordKey(row.record_keys)}`;
		const g = groups.get(key);
		if (!g) groups.set(key, { row, ids: row.id !== undefined ? [row.id] : [] });
		else {
			if (row.id !== undefined) g.ids.push(row.id);
			if (timeOf(row) > timeOf(g.row) || (timeOf(row) === timeOf(g.row) && attemptsOf(row) > attemptsOf(g.row))) g.row = row;
		}
	}
	return Array.from(groups.values());
}

/**
 * Decides what happens after a run of one agent on one step.
 * rows: the stored rows of this step (other steps are ignored).
 */
export function planAfterRun(rows: WaitRow[], run: FinishedRun, opts: WaitOptions = {}): AfterRunPlan {
	const maxAttempts = opts.maxAttempts ?? 5;
	const keepMs = (opts.keepDoneHours ?? 168) * 3600_000;
	const now = opts.now ?? new Date();
	const stepUuid = lower(run.stepUuid);
	const agentUuid = lower(run.agentUuid);
	const roles = uuidSet(run.roleUuids);
	const keys = recordKey(run.recordKeys ?? (parseEvent(run.event).keys as unknown));
	const started = Date.parse(run.startedAt);
	const onStep = rows.filter((r) => lower(r.step_uuid) === stepUuid);
	const waiting = onStep.filter((r) => lower(r.state) === 'waiting');
	const done = onStep.filter((r) => lower(r.state) === 'done');

	const myWaits = waiting.filter((r) => lower(r.agent_uuid) === agentUuid && String(r.run_id ?? '') === String(run.runId));
	const waited = myWaits.length > 0;
	const produced = !waited || myWaits.some((r) => truthy(r.progress));

	const remove: Array<number | string> = [];
	const wake: WakeUp[] = [];
	const stuck: WaitRow[] = [];
	const by = { agentName: String(run.agentName ?? ''), roles };

	// Done rows: one per agent and records; expired ones go.
	for (const r of done) {
		if (r.id === undefined) continue;
		const replaced = produced && lower(r.agent_uuid) === agentUuid && recordKey(r.record_keys) === keys;
		if (replaced || now.getTime() - timeOf(r) > keepMs) remove.push(r.id);
	}
	const doneRow: WaitRow | null = produced
		? {
				state: 'done',
				step_uuid: stepUuid,
				step_custom_id: run.stepCustomId ?? '',
				agent_uuid: agentUuid,
				agent_name: run.agentName ?? '',
				roles: roles.join(','),
				waits_for: '',
				reason: '',
				record_keys: keys,
				event: '',
				run_id: String(run.runId),
				attempts: run.attempt ?? 0,
				progress: true,
				at: now.toISOString(),
			}
		: null;

	// Wake the agents of this step that wait on one of the roles of this run.
	if (produced) {
		const candidates = waiting.filter((r) => lower(r.agent_uuid) !== agentUuid && sameRecords(r.record_keys, keys) && waitsOn(r, roles));
		for (const g of groupWaits(candidates)) {
			if (attemptsOf(g.row) >= maxAttempts) {
				stuck.push(g.row);
				continue;
			}
			remove.push(...g.ids);
			wake.push(wakeFor(g.row, by));
		}
	}

	// A result of an awaited role may have arrived while this agent was still checking: then go again now.
	if (waited) {
		const mine = groupWaits(myWaits)[0];
		const arrived = done.some(
			(d) =>
				lower(d.agent_uuid) !== agentUuid &&
				sameRecords(d.record_keys, keys) &&
				timeOf(d) >= (Number.isFinite(started) ? started : 0) &&
				waitsOn(mine.row, uuidSet(d.roles)),
		);
		if (arrived) {
			if (attemptsOf(mine.row) >= maxAttempts) stuck.push(mine.row);
			else {
				remove.push(...mine.ids);
				wake.push(wakeFor(mine.row, { agentName: 'arrived while waiting', roles: [] }));
			}
		}
	}

	return { waited, produced, doneRow, wake, remove: Array.from(new Set(remove)), stuck };
}

/**
 * Waits nobody answered for a while, e.g. because the awaited role is filled by a person.
 * Meant for a scheduler: it starts them again, within the attempt limit.
 */
export function findStaleWaits(rows: WaitRow[], opts: WaitOptions & { olderThanMinutes?: number } = {}): { wake: WakeUp[]; remove: Array<number | string>; stuck: WaitRow[] } {
	const maxAttempts = opts.maxAttempts ?? 5;
	const limit = (opts.olderThanMinutes ?? 60) * 60_000;
	const now = (opts.now ?? new Date()).getTime();
	const wake: WakeUp[] = [];
	const remove: Array<number | string> = [];
	const stuck: WaitRow[] = [];
	const waiting = rows.filter((r) => lower(r.state) === 'waiting');
	const byStep = new Map<string, WaitRow[]>();
	for (const r of waiting) byStep.set(lower(r.step_uuid), [...(byStep.get(lower(r.step_uuid)) ?? []), r]);
	for (const stepRows of byStep.values()) {
		for (const g of groupWaits(stepRows)) {
			if (now - timeOf(g.row) < limit) continue;
			if (attemptsOf(g.row) >= maxAttempts) {
				stuck.push(g.row);
				continue;
			}
			remove.push(...g.ids);
			wake.push(wakeFor(g.row, { agentName: 'scheduler', roles: [] }));
		}
	}
	return { wake, remove, stuck };
}
