/**
 * Waiting within a step. Parts of one step can depend on each other: an agent whose part
 * needs the result of another role does what it can, records a wait and ends. When a run
 * of another role of the same step ends with a result, the waiting agents are started again.
 *
 * The rows live in a store of the workflow (e.g. an n8n data table); these functions only
 * decide, so the same rules hold wherever the rows are kept.
 *
 *   state "waiting":   agent_uuid waits on step_uuid for the roles in waits_for (empty = any other role)
 *   state "done":      a run of agent_uuid with the roles in roles ended with a result at "at"
 *   state "running":   lease of a run that is in progress; one live lease per agent, step and records
 *   state "queued":    a start that arrived while the agent was busy; runs when the busy run ends
 *   state "escalated": a wait that reached the attempt limit and was reported to a person
 *
 * Safety rules:
 * - Every wake-up names one row (claimId). The workflow deletes that row first and wakes only
 *   if the delete really removed it, so two runs that plan at once never wake the same agent twice.
 * - Attempts are counted per wait; at the limit the wait is escalated, never woken again by itself.
 * - Text that one agent left for another (reason, event) is cut to fixed sizes and passed as data.
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
	/** Row to delete before waking; wake only if that delete removed it. */
	claimId: number | string | null;
	agentUuid: string;
	agentName: string;
	stepUuid: string;
	stepCustomId: string;
	recordKeys: string;
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
	/** Row ids to delete: older duplicates of woken waits, replaced or expired done rows, this run's lease. */
	remove: Array<number | string>;
	/** Waits that reached the attempt limit; the scheduler escalates them. */
	stuck: WaitRow[];
}

export interface Limits {
	maxAttempts?: number;
	keepDoneHours?: number;
	maxWaitMinutes?: number;
	runTimeoutMinutes?: number;
}

export interface WaitOptions extends Limits {
	now?: Date;
	/** Limits per agent and step (e.g. from Runner Settings); they win over the plain options. */
	limitsFor?: (target: { agentUuid: string; stepUuid: string; stepCustomId: string }) => Limits;
}

export const MAX_REASON_CHARS = 500;
export const MAX_EVENT_CHARS = 20_000;

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

/** Cuts text to a fixed size, so one agent cannot flood the next one's prompt. */
export function clip(value: unknown, max: number): string {
	const s = String(value ?? '');
	return s.length > max ? `${s.slice(0, max)} …[cut]` : s;
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

function idOrder(a: WaitRow, b: WaitRow): number {
	const na = Number(a.id);
	const nb = Number(b.id);
	if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
	return String(a.id ?? '').localeCompare(String(b.id ?? ''));
}

export function parseEvent(value: unknown): Record<string, unknown> {
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		const json = JSON.stringify(value);
		return json.length > MAX_EVENT_CHARS ? { text: clip(json, MAX_EVENT_CHARS) } : { ...(value as Record<string, unknown>) };
	}
	if (typeof value === 'string' && value.trim()) {
		if (value.length <= MAX_EVENT_CHARS) {
			try {
				const parsed = JSON.parse(value);
				if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
			} catch {
				/* keep as text */
			}
		}
		return { text: clip(value, MAX_EVENT_CHARS) };
	}
	return {};
}

function waitsOn(row: WaitRow, roleUuids: string[]): boolean {
	const wanted = uuidSet(row.waits_for);
	return wanted.length === 0 || wanted.some((r) => roleUuids.includes(r));
}

function wakeFor(row: WaitRow, by: { agentName: string; roles: string[] }, claimId: number | string | null): WakeUp {
	const attempt = attemptsOf(row) + 1;
	const event = parseEvent(row.event);
	delete event.wake;
	event.wake = { attempt, wokenBy: clip(by.agentName, 200), wokenByRoles: by.roles, waitedFor: clip(row.reason, MAX_REASON_CHARS) };
	return {
		claimId,
		agentUuid: lower(row.agent_uuid),
		agentName: clip(row.agent_name, 200),
		stepUuid: lower(row.step_uuid),
		stepCustomId: String(row.step_custom_id ?? ''),
		recordKeys: recordKey(row.record_keys),
		attempt,
		event,
	};
}

/** The newest row per agent and records; the others are removed with it. */
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

function limitsOf(opts: WaitOptions, row: { agent_uuid?: string | null; step_uuid?: string | null; step_custom_id?: string | null }): Required<Limits> {
	const own = opts.limitsFor?.({ agentUuid: lower(row.agent_uuid), stepUuid: lower(row.step_uuid), stepCustomId: String(row.step_custom_id ?? '') }) ?? {};
	return {
		maxAttempts: own.maxAttempts ?? opts.maxAttempts ?? 5,
		keepDoneHours: own.keepDoneHours ?? opts.keepDoneHours ?? 168,
		maxWaitMinutes: own.maxWaitMinutes ?? opts.maxWaitMinutes ?? 60,
		runTimeoutMinutes: own.runTimeoutMinutes ?? opts.runTimeoutMinutes ?? 15,
	};
}

/** Adds a group as a wake-up with a claim, or as stuck at the attempt limit. */
function wakeOrStick(g: { row: WaitRow; ids: Array<number | string> }, by: { agentName: string; roles: string[] }, maxAttempts: number, out: { wake: WakeUp[]; remove: Array<number | string>; stuck: WaitRow[] }) {
	if (attemptsOf(g.row) >= maxAttempts) {
		out.stuck.push(g.row);
		return;
	}
	const claimId = g.row.id ?? null;
	out.remove.push(...g.ids.filter((id) => id !== claimId));
	out.wake.push(wakeFor(g.row, by, claimId));
}

/**
 * Decides what happens after a run of one agent on one step.
 * rows: the stored rows of this step (other steps are ignored).
 */
export function planAfterRun(rows: WaitRow[], run: FinishedRun, opts: WaitOptions = {}): AfterRunPlan {
	const now = opts.now ?? new Date();
	const stepUuid = lower(run.stepUuid);
	const agentUuid = lower(run.agentUuid);
	const roles = uuidSet(run.roleUuids);
	const keys = recordKey(run.recordKeys ?? (parseEvent(run.event).keys as unknown));
	const started = Date.parse(run.startedAt);
	const onStep = rows.filter((r) => lower(r.step_uuid) === stepUuid);
	const state = (s: string) => onStep.filter((r) => lower(r.state) === s);
	const waiting = state('waiting');
	const done = state('done');
	const own = limitsOf(opts, { agent_uuid: agentUuid, step_uuid: stepUuid, step_custom_id: run.stepCustomId });

	const myWaits = waiting.filter((r) => lower(r.agent_uuid) === agentUuid && String(r.run_id ?? '') === String(run.runId));
	const waited = myWaits.length > 0;
	const produced = !waited || myWaits.some((r) => truthy(r.progress));

	const out = { wake: [] as WakeUp[], remove: [] as Array<number | string>, stuck: [] as WaitRow[] };
	const by = { agentName: String(run.agentName ?? ''), roles };

	// This run's lease ends with it.
	for (const r of state('running')) if (r.id !== undefined && String(r.run_id ?? '') === String(run.runId)) out.remove.push(r.id);

	// Done and escalated rows: one done row per agent and records; expired ones go.
	for (const r of [...done, ...state('escalated')]) {
		if (r.id === undefined) continue;
		const keepMs = limitsOf(opts, r).keepDoneHours * 3600_000;
		const replaced = lower(r.state) === 'done' && produced && lower(r.agent_uuid) === agentUuid && recordKey(r.record_keys) === keys;
		if (replaced || now.getTime() - timeOf(r) > keepMs) out.remove.push(r.id);
	}
	const doneRow: WaitRow | null = produced
		? {
				state: 'done',
				step_uuid: stepUuid,
				step_custom_id: run.stepCustomId ?? '',
				agent_uuid: agentUuid,
				agent_name: clip(run.agentName, 200),
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
		for (const g of groupWaits(candidates)) wakeOrStick(g, by, limitsOf(opts, g.row).maxAttempts, out);
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
		if (arrived) wakeOrStick(mine, { agentName: 'arrived while waiting', roles: [] }, own.maxAttempts, out);
	}

	// Starts that came in while this run was busy run now, newest event first.
	const queued = state('queued').filter((r) => lower(r.agent_uuid) === agentUuid && sameRecords(r.record_keys, keys));
	for (const g of groupWaits(queued)) wakeOrStick(g, { agentName: 'queued while running', roles: [] }, own.maxAttempts, out);

	return { waited, produced, doneRow, wake: out.wake, remove: Array.from(new Set(out.remove)), stuck: out.stuck };
}

export interface StartCheck {
	/** Whether this run may go on. */
	start: boolean;
	reason: string;
	/** The live lease of another run that blocks this one. */
	blockedBy: string | null;
	/** Rows to delete: this run's own lease when it may not start, and dead leases. */
	remove: Array<number | string>;
	/** When blocked: a row to add so the start runs after the busy run (state "queued"). */
	queueRow: WaitRow | null;
}

/**
 * Duplicate-run guard. The workflow first adds a lease row for this run (state "running",
 * run_id), then reads the leases of the step and asks here. Of the live leases of the same
 * agent and records the oldest wins; a later one does not start and is queued instead, so
 * nothing is lost and nothing runs twice. Leases older than the run timeout count as dead.
 */
export function checkStart(rows: WaitRow[], run: Omit<FinishedRun, 'roleUuids' | 'startedAt'> & { roleUuids?: string[]; startedAt?: string }, opts: WaitOptions = {}): StartCheck {
	const now = (opts.now ?? new Date()).getTime();
	const agentUuid = lower(run.agentUuid);
	const stepUuid = lower(run.stepUuid);
	const keys = recordKey(run.recordKeys ?? (parseEvent(run.event).keys as unknown));
	const timeoutMs = limitsOf(opts, { agent_uuid: agentUuid, step_uuid: stepUuid, step_custom_id: run.stepCustomId }).runTimeoutMinutes * 60_000;
	const leases = rows.filter((r) => lower(r.state) === 'running' && lower(r.step_uuid) === stepUuid && lower(r.agent_uuid) === agentUuid);
	const remove: Array<number | string> = [];
	const live: WaitRow[] = [];
	for (const r of leases) {
		if (now - timeOf(r) > timeoutMs) {
			if (r.id !== undefined) remove.push(r.id);
		} else if (sameRecords(r.record_keys, keys)) live.push(r);
	}
	const mine = live.filter((r) => String(r.run_id ?? '') === String(run.runId));
	if (mine.length === 0) {
		return { start: false, reason: 'No lease of this run was found; refusing to start', blockedBy: null, remove, queueRow: null };
	}
	live.sort((a, b) => timeOf(a) - timeOf(b) || idOrder(a, b));
	const winner = live[0];
	if (String(winner.run_id ?? '') === String(run.runId)) {
		// Own extra lease rows (e.g. a retried insert) go as well.
		remove.push(...mine.filter((r) => r !== winner && r.id !== undefined).map((r) => r.id!));
		return { start: true, reason: 'No other run of this agent is busy with these records', blockedBy: null, remove, queueRow: null };
	}
	remove.push(...mine.filter((r) => r.id !== undefined).map((r) => r.id!));
	const event = parseEvent(run.event);
	return {
		start: false,
		reason: `Agent is busy with the same records in run ${winner.run_id}; this start is queued`,
		blockedBy: String(winner.run_id ?? ''),
		remove,
		queueRow: {
			state: 'queued',
			step_uuid: stepUuid,
			step_custom_id: run.stepCustomId ?? '',
			agent_uuid: agentUuid,
			agent_name: clip(run.agentName, 200),
			roles: '',
			waits_for: '',
			reason: 'Started while the agent was busy with the same records',
			record_keys: keys,
			event: JSON.stringify(event),
			run_id: String(winner.run_id ?? ''),
			attempts: Math.max(0, Math.floor(Number(run.attempt) || 0)),
			progress: '',
			at: new Date(now).toISOString(),
		},
	};
}

export interface StaleResult {
	wake: WakeUp[];
	remove: Array<number | string>;
	/** Waits at the attempt limit (already escalated ones excluded). */
	stuck: WaitRow[];
	/** Row ids to set to state "escalated" once the report went out. */
	escalate: Array<number | string>;
}

/**
 * For a scheduler: waits nobody answered within maxWaitMinutes (e.g. because a person fills
 * the awaited role), queued starts whose busy run died, dead leases and expired rows.
 * Waits at the attempt limit are returned once for escalation, never woken again by themselves.
 */
export function findStaleWaits(rows: WaitRow[], opts: WaitOptions & { olderThanMinutes?: number } = {}): StaleResult {
	const now = (opts.now ?? new Date()).getTime();
	const base: WaitOptions = { ...opts, maxWaitMinutes: opts.olderThanMinutes ?? opts.maxWaitMinutes };
	const out = { wake: [] as WakeUp[], remove: [] as Array<number | string>, stuck: [] as WaitRow[] };
	const escalate: Array<number | string> = [];
	const liveLeases: WaitRow[] = [];

	for (const r of rows) {
		const s = lower(r.state);
		const lim = limitsOf(base, r);
		if (s === 'running') {
			if (now - timeOf(r) > lim.runTimeoutMinutes * 60_000) {
				if (r.id !== undefined) out.remove.push(r.id);
			} else liveLeases.push(r);
		} else if ((s === 'done' || s === 'escalated') && r.id !== undefined && now - timeOf(r) > lim.keepDoneHours * 3600_000) {
			out.remove.push(r.id);
		}
	}
	const busy = (r: WaitRow) =>
		liveLeases.some((l) => lower(l.agent_uuid) === lower(r.agent_uuid) && lower(l.step_uuid) === lower(r.step_uuid) && sameRecords(l.record_keys, r.record_keys));

	const byStep = new Map<string, WaitRow[]>();
	for (const r of rows) {
		const s = lower(r.state);
		if (s !== 'waiting' && s !== 'queued') continue;
		const key = `${s}|${lower(r.step_uuid)}`;
		byStep.set(key, [...(byStep.get(key) ?? []), r]);
	}
	for (const [key, stepRows] of byStep) {
		const queued = key.startsWith('queued|');
		for (const g of groupWaits(stepRows)) {
			const lim = limitsOf(base, g.row);
			// A queued start waits for its busy run; only when that run is gone does the scheduler start it.
			if (queued ? busy(g.row) : now - timeOf(g.row) < lim.maxWaitMinutes * 60_000) continue;
			if (!queued && busy(g.row)) continue;
			const before = out.stuck.length;
			wakeOrStick(g, { agentName: 'scheduler', roles: [] }, lim.maxAttempts, out);
			if (out.stuck.length > before && g.row.id !== undefined) {
				escalate.push(g.row.id);
				out.remove.push(...g.ids.filter((id) => id !== g.row.id));
			}
		}
	}
	return { wake: out.wake, remove: Array.from(new Set(out.remove)), stuck: out.stuck, escalate };
}
