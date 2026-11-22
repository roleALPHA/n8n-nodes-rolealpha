import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costOf, parsePriceTable, priceFor, priceTableFromRows } from '../lib/pricing';

const TABLE = parsePriceTable({
	currency: 'USD',
	asOf: '2026-11-20',
	models: {
		'claude-opus-5-5': { input: 4, cacheRead: 0.4, cacheWrite: 5, output: 20 },
		'claude-opus-5': { input: 5, output: 25 },
		'gpt-x': { input: '1,5', output: 6 },
	},
});

test('pricing: tokens times the rate per million, in the table currency', () => {
	const p = costOf({ inputTokens: 12_000, cacheReadTokens: 30_000, outputTokens: 1_800 }, 'claude-opus-5-5', TABLE);
	assert.deepEqual(p, { cost: 0.096, currency: 'USD', priceKind: 'tabelle', priceSource: 'runner-tabelle 2026-11-20' });
});

test('pricing: a dated variant uses its model row, never the next generation by prefix', () => {
	assert.equal(priceFor('claude-opus-5-5-20261101', TABLE)?.input, 4);
	assert.equal(priceFor('claude-opus-5-5', TABLE)?.input, 4);
	// "claude-opus-5" must not price "claude-opus-5-5x" or "claude-opus-55".
	assert.equal(priceFor('claude-opus-55', TABLE), null);
	assert.equal(priceFor('claude-opus-5-1', TABLE)?.input, 5, 'dated variant of claude-opus-5');
});

test('pricing: no row, no price — the run is reported with tokens only', () => {
	assert.equal(costOf({ inputTokens: 10 }, 'unknown-model', TABLE), null);
	assert.equal(costOf({ inputTokens: 10 }, undefined, TABLE), null);
});

test('pricing: cache tokens without a cache rate are not guessed', () => {
	assert.equal(costOf({ inputTokens: 10, cacheReadTokens: 5 }, 'claude-opus-5', TABLE), null);
	// Counter-check: without cache tokens the same model is priced.
	assert.equal(costOf({ inputTokens: 1_000_000 }, 'claude-opus-5', TABLE)?.cost, 5);
});

test('pricing: decimal comma in a row is accepted', () => {
	assert.equal(costOf({ inputTokens: 1_000_000 }, 'gpt-x', TABLE)?.cost, 1.5);
});

test('pricing: rows from a data table', () => {
	const t = priceTableFromRows([
		{ model: 'm1', input: 1, output: 2, currency: 'eur', asOf: 'Vertrag 2026' },
		{ model: 'm2', input: '3', output: '4', currency: 'EUR' },
	]);
	assert.equal(t.currency, 'EUR');
	assert.equal(t.asOf, 'Vertrag 2026');
	assert.equal(costOf({ outputTokens: 500_000 }, 'm2', t)?.cost, 2);
});

test('pricing: refuses what it would have to guess', () => {
	assert.throws(() => priceTableFromRows([]), /no rows/);
	assert.throws(() => priceTableFromRows([{ model: 'm', input: 1, output: 1, currency: 'Dollar' }]), /ISO/);
	assert.throws(() => priceTableFromRows([{ model: 'm', input: 1, currency: 'USD' }]), /output/);
	assert.throws(() => priceTableFromRows([{ model: 'm', input: -1, output: 1, currency: 'USD' }]), /price per million/);
	assert.throws(() => priceTableFromRows([{ model: 'a', input: 1, output: 1, currency: 'USD' }, { model: 'b', input: 1, output: 1, currency: 'EUR' }]), /one currency/);
	assert.throws(() => priceTableFromRows([{ model: 'a', input: 1, output: 1, currency: 'USD' }, { model: 'a', input: 1, output: 1, currency: 'USD' }]), /twice/);
	assert.throws(() => parsePriceTable({ currency: 'USD' }), /models/);
});
