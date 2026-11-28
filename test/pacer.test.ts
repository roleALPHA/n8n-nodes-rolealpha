import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MAX_PER_MINUTE, RequestPacer, maxPerMinute, sharedPacer } from '../lib/pacer';

/** A fake clock that only moves when the pacer sleeps. */
function fakeTime() {
	let t = 1_000_000;
	const slept: number[] = [];
	return {
		now: () => t,
		sleep: async (ms: number) => {
			slept.push(ms);
			t += ms;
		},
		slept,
		advance: (ms: number) => {
			t += ms;
		},
	};
}

test('RequestPacer lets up to max requests start at once, the next one waits for the window', async () => {
	const time = fakeTime();
	const pacer = new RequestPacer(3, 60_000, time.now, time.sleep);
	for (let i = 0; i < 3; i++) await pacer.acquire();
	assert.deepEqual(time.slept, [], 'the first three start without waiting');
	await pacer.acquire();
	assert.equal(time.slept.length, 1, 'the fourth waits once');
	assert.ok(time.slept[0] >= 60_000, 'until the oldest start left the window');
});

test('RequestPacer does not wait when earlier starts already left the window (counter-check)', async () => {
	const time = fakeTime();
	const pacer = new RequestPacer(2, 60_000, time.now, time.sleep);
	await pacer.acquire();
	await pacer.acquire();
	time.advance(60_001);
	await pacer.acquire();
	assert.deepEqual(time.slept, []);
});

test('RequestPacer serves concurrent callers in arrival order and never more than max per window', async () => {
	const time = fakeTime();
	const pacer = new RequestPacer(2, 60_000, time.now, time.sleep);
	const started: Array<{ id: number; at: number }> = [];
	await Promise.all([1, 2, 3, 4, 5].map((id) => pacer.acquire().then(() => started.push({ id, at: time.now() }))));
	assert.deepEqual(started.map((s) => s.id), [1, 2, 3, 4, 5]);
	for (const s of started) {
		const inWindow = started.filter((o) => o.at > s.at - 60_000 && o.at <= s.at).length;
		assert.ok(inWindow <= 2, `at most 2 starts in any window, saw ${inWindow}`);
	}
});

test('maxPerMinute: default below the server limit, override by env, 0 turns pacing off', () => {
	assert.equal(maxPerMinute({}), DEFAULT_MAX_PER_MINUTE);
	assert.ok(DEFAULT_MAX_PER_MINUTE < 120);
	assert.equal(maxPerMinute({ ROLEALPHA_MCP_MAX_PER_MINUTE: '60' }), 60);
	assert.equal(maxPerMinute({ ROLEALPHA_MCP_MAX_PER_MINUTE: '0' }), 0);
	assert.equal(maxPerMinute({ ROLEALPHA_MCP_MAX_PER_MINUTE: 'abc' }), DEFAULT_MAX_PER_MINUTE);
});

test('sharedPacer returns one pacer per access key and separate ones for different keys', () => {
	const a1 = sharedPacer('https://x/api/mcp|cred-a');
	const a2 = sharedPacer('https://x/api/mcp|cred-a');
	const b = sharedPacer('https://x/api/mcp|cred-b');
	assert.ok(a1 && a2 && b);
	assert.equal(a1, a2);
	assert.notEqual(a1, b);
});
