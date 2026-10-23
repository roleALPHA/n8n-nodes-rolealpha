/**
 * Runner settings: limits for waiting, retries, escalation and run time. Defaults live
 * here; a workflow can override them per organisation, step or agent from a table
 * (scope, target, key, value), so a change takes effect without republishing anything.
 *
 * Every value is clamped to fixed bounds: a wrong or hostile table row can make the
 * runner more careful, but never unbounded (no endless waking, no endless runs).
 */

export interface RunnerSettings {
	/** Minutes a wait may stay unanswered before the scheduler starts the agent again. */
	maxWaitMinutes: number;
	/** How often one agent is woken for the same step and records before it escalates. */
	maxAttempts: number;
	/** Hours done and escalated rows are kept. */
	keepDoneHours: number;
	/** Tool calls of the agent per run. */
	maxIterations: number;
	/** Minutes after which a run counts as dead; its lease is released. */
	runTimeoutMinutes: number;
	/** Whether stuck waits are reported to the role that leads the agent's circle. */
	escalate: boolean;
	/** Hours a share decision is reused while step, roles and trigger stay the same; 0 = never. */
	shareCacheHours: number;
}

export type SettingKey = keyof RunnerSettings;

export const DEFAULT_SETTINGS: RunnerSettings = {
	maxWaitMinutes: 60,
	maxAttempts: 5,
	keepDoneHours: 168,
	maxIterations: 15,
	runTimeoutMinutes: 15,
	escalate: true,
	shareCacheHours: 24,
};

export const SETTING_BOUNDS: Record<Exclude<SettingKey, 'escalate'>, { min: number; max: number }> = {
	maxWaitMinutes: { min: 5, max: 10080 },
	maxAttempts: { min: 1, max: 20 },
	keepDoneHours: { min: 1, max: 2160 },
	maxIterations: { min: 1, max: 50 },
	runTimeoutMinutes: { min: 1, max: 120 },
	shareCacheHours: { min: 0, max: 720 },
};

export interface SettingRow {
	scope?: string | null;
	target?: string | null;
	key?: string | null;
	value?: unknown;
}

export interface SettingsTarget {
	agentUuid?: string | null;
	stepUuid?: string | null;
	stepCustomId?: string | null;
}

export interface ResolvedSettings {
	settings: RunnerSettings;
	/** Where each value came from: default, global, step or agent. */
	sources: Record<SettingKey, string>;
	/** Rows that were ignored or clamped, with the reason. */
	problems: string[];
}

const SCOPE_RANK: Record<string, number> = { global: 1, step: 2, agent: 3 };
const lower = (v: unknown) => String(v ?? '').trim().toLowerCase();

function parseBool(value: unknown): boolean | null {
	if (typeof value === 'boolean') return value;
	const v = lower(value);
	if (['true', '1', 'yes', 'ja', 'on'].includes(v)) return true;
	if (['false', '0', 'no', 'nein', 'off'].includes(v)) return false;
	return null;
}

/** Checks one value; numbers are rounded and clamped. Returns null for a value that is unusable. */
export function checkSetting(key: SettingKey, value: unknown): { value: number | boolean; note?: string } | null {
	if (key === 'escalate') {
		const b = parseBool(value);
		return b === null ? null : { value: b };
	}
	const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
	if (!Number.isFinite(n)) return null;
	const { min, max } = SETTING_BOUNDS[key];
	const r = Math.round(n);
	const clamped = Math.min(max, Math.max(min, r));
	return clamped === r ? { value: clamped } : { value: clamped, note: `clamped to ${clamped} (allowed ${min}–${max})` };
}

function matches(row: SettingRow, scope: string, target: SettingsTarget): boolean {
	if (scope === 'global') return true;
	const t = lower(row.target);
	if (t === '') return false;
	if (scope === 'agent') return t === lower(target.agentUuid);
	return t === lower(target.stepUuid) || (!!target.stepCustomId && t === lower(target.stepCustomId));
}

/** Defaults < global < step < agent. Unknown keys and unusable values are reported, never applied. */
export function resolveSettings(rows: SettingRow[], target: SettingsTarget = {}): ResolvedSettings {
	const settings: RunnerSettings = { ...DEFAULT_SETTINGS };
	const sources = Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, 'default'])) as Record<SettingKey, string>;
	const rank = Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, 0])) as Record<SettingKey, number>;
	const problems: string[] = [];
	const keys = new Map(Object.keys(DEFAULT_SETTINGS).map((k) => [k.toLowerCase(), k as SettingKey]));

	for (const row of Array.isArray(rows) ? rows : []) {
		if (!row || typeof row !== 'object') continue;
		const scope = lower(row.scope) || 'global';
		const label = `${scope}${row.target ? `:${row.target}` : ''}/${row.key ?? ''}`;
		if (!SCOPE_RANK[scope]) {
			problems.push(`${label}: unknown scope`);
			continue;
		}
		const key = keys.get(lower(row.key));
		if (!key) {
			problems.push(`${label}: unknown key`);
			continue;
		}
		if (!matches(row, scope, target)) continue;
		const checked = checkSetting(key, row.value);
		if (!checked) {
			problems.push(`${label}: unusable value ${JSON.stringify(row.value)}`);
			continue;
		}
		if (checked.note) problems.push(`${label}: ${checked.note}`);
		if (SCOPE_RANK[scope] < rank[key]) continue;
		(settings as unknown as Record<string, unknown>)[key] = checked.value;
		sources[key] = scope;
		rank[key] = SCOPE_RANK[scope];
	}
	return { settings, sources, problems };
}
