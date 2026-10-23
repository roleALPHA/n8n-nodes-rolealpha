/**
 * Is a step due? roleALPHA only knows a coarse `frequency` and an optional date
 * (`termin`). A step is due once per period; the scheduler records the last run
 * and catches up after downtime instead of firing at a fixed minute.
 */

export const SCHEDULED_FREQUENCIES = ['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'semiannual', 'annual'] as const;
export type Frequency = (typeof SCHEDULED_FREQUENCIES)[number] | 'event_driven' | 'on_demand';

export interface DueOptions {
	timeZone?: string;
	/** Date from roleALPHA (`YYYY-MM-DD`). If set, the step is due once on or after it. */
	dueDate?: string | null;
	/** ISO weekday 1 (Mon) … 7 (Sun): weekly and biweekly steps start on or after this day. */
	weekday?: number | null;
	/** Local hour 0–23 before which nothing is due on a given day. */
	notBeforeHour?: number | null;
}

export interface DueResult {
	due: boolean;
	reason: string;
	period: string | null;
}

interface LocalDate {
	year: number;
	month: number;
	day: number;
	hour: number;
	weekday: number;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function localDate(date: Date, timeZone = 'Europe/Berlin'): LocalDate {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		hourCycle: 'h23',
		weekday: 'short',
	}).formatToParts(date);
	const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
	return {
		year: Number(get('year')),
		month: Number(get('month')),
		day: Number(get('day')),
		hour: Number(get('hour')) % 24,
		weekday: WEEKDAYS[get('weekday')] ?? 1,
	};
}

/** ISO week-numbering year and week of a calendar date. */
export function isoWeek(year: number, month: number, day: number): { year: number; week: number } {
	const d = new Date(Date.UTC(year, month - 1, day));
	const weekday = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
	d.setUTCDate(d.getUTCDate() + 4 - weekday);
	const isoYear = d.getUTCFullYear();
	const start = Date.UTC(isoYear, 0, 1);
	return { year: isoYear, week: Math.ceil(((d.getTime() - start) / 86400000 + 1) / 7) };
}

const pad = (n: number) => String(n).padStart(2, '0');

export function periodKey(frequency: string, l: LocalDate): string | null {
	switch (frequency) {
		case 'daily':
			return `${l.year}-${pad(l.month)}-${pad(l.day)}`;
		case 'weekly': {
			const w = isoWeek(l.year, l.month, l.day);
			return `${w.year}-W${pad(w.week)}`;
		}
		case 'biweekly': {
			const w = isoWeek(l.year, l.month, l.day);
			return `${w.year}-B${pad(Math.ceil(w.week / 2))}`;
		}
		case 'monthly':
			return `${l.year}-${pad(l.month)}`;
		case 'quarterly':
			return `${l.year}-Q${Math.ceil(l.month / 3)}`;
		case 'semiannual':
			return `${l.year}-H${l.month <= 6 ? 1 : 2}`;
		case 'annual':
			return `${l.year}`;
		default:
			return null;
	}
}

function parseDate(value: unknown): Date | null {
	if (value === null || value === undefined || value === '') return null;
	const d = value instanceof Date ? value : new Date(String(value));
	return Number.isNaN(d.getTime()) ? null : d;
}

export function isDue(frequency: string | null | undefined, lastRunAt: unknown, now: Date = new Date(), opts: DueOptions = {}): DueResult {
	const tz = opts.timeZone ?? 'Europe/Berlin';
	const today = localDate(now, tz);
	const todayIso = `${today.year}-${pad(today.month)}-${pad(today.day)}`;
	const last = parseDate(lastRunAt);
	if (typeof opts.notBeforeHour === 'number' && today.hour < opts.notBeforeHour) {
		return { due: false, reason: `Not before ${opts.notBeforeHour}:00`, period: null };
	}

	if (opts.dueDate) {
		const dueDate = String(opts.dueDate).slice(0, 10);
		if (todayIso < dueDate) return { due: false, reason: `Due on ${dueDate}`, period: dueDate };
		if (last) {
			const l = localDate(last, tz);
			if (`${l.year}-${pad(l.month)}-${pad(l.day)}` >= dueDate) return { due: false, reason: `Already ran for ${dueDate}`, period: dueDate };
		}
		return { due: true, reason: `Due date ${dueDate} reached`, period: dueDate };
	}

	const freq = String(frequency ?? '').trim();
	if (freq === 'event_driven' || freq === 'on_demand') return { due: false, reason: `Runs only on events (${freq})`, period: null };
	const period = periodKey(freq, today);
	if (period === null) return { due: false, reason: freq ? `Unknown frequency "${freq}"` : 'No frequency set', period: null };
	if ((freq === 'weekly' || freq === 'biweekly') && typeof opts.weekday === 'number' && today.weekday < opts.weekday) {
		return { due: false, reason: `Starts on ISO weekday ${opts.weekday}`, period };
	}
	if (last && periodKey(freq, localDate(last, tz)) === period) return { due: false, reason: `Already ran in ${period}`, period };
	return { due: true, reason: last ? `New period ${period}` : 'Never ran', period };
}
