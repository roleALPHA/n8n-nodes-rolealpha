/**
 * Spreads requests over a shared roleALPHA access so a burst waits instead of being refused.
 *
 * roleALPHA limits `/api/mcp` per access (token fingerprint): 120 requests per minute. All
 * workflows of one n8n server that use the same roleALPHA credential share that budget, but
 * none of them knows about the others. Before this pacer a scheduler that read the duties of
 * every agent at :15 and :30 met other workflows starting at the same minute; together they
 * crossed the limit and the run failed with HTTP 429, although waiting a few seconds would
 * have been enough.
 *
 * The pacer lives in the n8n process, so every execution that uses the same key waits in the
 * same queue. It keeps a sliding window of start times and lets a request start only while
 * fewer than `max` requests started in the last `windowMs`. Agent runs with their own run
 * token have their own budget on the server and are not paced here.
 */

export type Clock = () => number;
export type Sleep = (ms: number) => Promise<void>;

/** Below the server's 120 so retries and other clients of the same access keep some room. */
export const DEFAULT_MAX_PER_MINUTE = 100;
const WINDOW_MS = 60_000;

const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class RequestPacer {
	private readonly starts: number[] = [];
	private tail: Promise<void> = Promise.resolve();

	constructor(
		private readonly max: number,
		private readonly windowMs = WINDOW_MS,
		private readonly now: Clock = Date.now,
		private readonly sleep: Sleep = realSleep,
	) {}

	/** Resolves when the caller may send one request; callers are served in arrival order. */
	acquire(): Promise<void> {
		const turn = this.tail.then(() => this.waitForSlot());
		// A failed wait must not block everyone behind it.
		this.tail = turn.catch(() => undefined);
		return turn;
	}

	private async waitForSlot(): Promise<void> {
		for (;;) {
			const t = this.now();
			while (this.starts.length > 0 && this.starts[0] <= t - this.windowMs) this.starts.shift();
			if (this.starts.length < this.max) {
				this.starts.push(t);
				return;
			}
			await this.sleep(this.starts[0] + this.windowMs - t + 1);
		}
	}
}

/** Requests per minute for one shared access; `ROLEALPHA_MCP_MAX_PER_MINUTE` overrides, 0 turns pacing off. */
export function maxPerMinute(env: Record<string, string | undefined> = process.env): number {
	const raw = env.ROLEALPHA_MCP_MAX_PER_MINUTE;
	if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_PER_MINUTE;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_MAX_PER_MINUTE;
}

const pacers = new Map<string, RequestPacer>();

/** The process-wide pacer for one access (endpoint and credential), or none when pacing is off. */
export function sharedPacer(key: string): RequestPacer | undefined {
	const max = maxPerMinute();
	if (max === 0) return undefined;
	let pacer = pacers.get(key);
	if (!pacer) {
		pacer = new RequestPacer(max);
		pacers.set(key, pacer);
	}
	return pacer;
}
