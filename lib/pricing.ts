/**
 * The cost of one agent run, from the runner's own price table.
 *
 * roleALPHA does not price agent runs. With the customer's own AI key the price depends on the
 * contract behind that key, and only the runner knows which key it used. So the runner prices
 * the tokens of a run with its table and reports the cost (agentRun.ts, reportUsage). A model
 * without a row has no price: the run is reported with tokens only, and roleALPHA counts it as
 * "without a price" — never as 0.
 *
 * Prices are per million tokens. `input` is for UNCACHED input tokens; cache reads and writes
 * have their own rates (they cost a fraction or a premium of the input rate).
 */

export interface ModelPrice {
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
}

export interface PriceTable {
	/** ISO 4217, e.g. USD. One currency per table. */
	currency: string;
	/** Which price list this is, for people, e.g. a date. Reported as the price source. */
	asOf: string;
	models: Record<string, ModelPrice>;
}

export interface Usage {
	inputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	outputTokens?: number;
}

export interface Priced {
	cost: number;
	currency: string;
	priceKind: 'tabelle';
	priceSource: string;
}

const CURRENCY = /^[A-Z]{3}$/;

function rate(v: unknown, field: string, model: string, required: boolean): number | undefined {
	if (v === undefined || v === null || v === '') {
		if (required) throw new Error(`Price table: "${model}" needs ${field}`);
		return undefined;
	}
	const n = typeof v === 'string' ? Number(v.replace(',', '.')) : Number(v);
	if (!Number.isFinite(n) || n < 0) throw new Error(`Price table: ${field} of "${model}" is not a price per million tokens`);
	return n;
}

/**
 * A price table from rows (e.g. an n8n Data Table): one row per model with `model`, `input`,
 * `output`, optional `cacheRead`, `cacheWrite`, and `currency` / `asOf` (same in every row).
 * Throws on anything it would otherwise have to guess.
 */
export function priceTableFromRows(rows: ReadonlyArray<Record<string, unknown>>): PriceTable {
	const models: Record<string, ModelPrice> = {};
	let currency = '';
	let asOf = '';
	for (const row of rows) {
		const model = String(row.model ?? '').trim();
		if (!model) throw new Error('Price table: every row needs a model');
		const c = String(row.currency ?? '').trim().toUpperCase();
		if (!CURRENCY.test(c)) throw new Error(`Price table: currency of "${model}" is not an ISO code like USD`);
		if (currency && c !== currency) throw new Error('Price table: one currency per table');
		currency = c;
		if (!asOf && row.asOf) asOf = String(row.asOf).trim();
		if (models[model]) throw new Error(`Price table: "${model}" appears twice`);
		models[model] = {
			input: rate(row.input, 'input', model, true)!,
			output: rate(row.output, 'output', model, true)!,
			cacheRead: rate(row.cacheRead, 'cacheRead', model, false),
			cacheWrite: rate(row.cacheWrite, 'cacheWrite', model, false),
		};
	}
	if (!currency) throw new Error('Price table: no rows');
	return { currency, asOf, models };
}

/** A price table from JSON: `{ currency, asOf, models: { "<model>": { input, output, … } } }`. */
export function parsePriceTable(json: unknown): PriceTable {
	const raw = typeof json === 'string' ? (JSON.parse(json) as unknown) : json;
	if (!raw || typeof raw !== 'object') throw new Error('Price table: expected an object');
	const t = raw as Record<string, unknown>;
	const models = t.models && typeof t.models === 'object' ? (t.models as Record<string, Record<string, unknown>>) : null;
	if (!models) throw new Error('Price table: "models" is missing');
	return priceTableFromRows(Object.entries(models).map(([model, p]) => ({ ...p, model, currency: t.currency, asOf: t.asOf })));
}

/**
 * The row for a model: exact name first, else the longest name the model starts with followed by
 * "-" or "@" (dated or provider-specific variants such as `claude-opus-5-5-20261101`). Never the
 * next model generation by a shared prefix.
 */
export function priceFor(model: string | undefined, table: PriceTable): ModelPrice | null {
	if (!model) return null;
	if (table.models[model]) return table.models[model];
	let best: string | null = null;
	for (const name of Object.keys(table.models)) {
		if ((model.startsWith(`${name}-`) || model.startsWith(`${name}@`)) && (!best || name.length > best.length)) best = name;
	}
	return best ? table.models[best] : null;
}

/** The cost of a run, or `null` when the table has no price for the model. */
export function costOf(usage: Usage, model: string | undefined, table: PriceTable): Priced | null {
	const p = priceFor(model, table);
	if (!p) return null;
	const cacheRead = usage.cacheReadTokens ?? 0;
	const cacheWrite = usage.cacheWriteTokens ?? 0;
	if (cacheRead > 0 && p.cacheRead === undefined) return null;
	if (cacheWrite > 0 && p.cacheWrite === undefined) return null;
	const micro =
		(usage.inputTokens ?? 0) * p.input +
		cacheRead * (p.cacheRead ?? 0) +
		cacheWrite * (p.cacheWrite ?? 0) +
		(usage.outputTokens ?? 0) * p.output;
	// Per million tokens; rounded to a millionth of the currency unit.
	const cost = Math.round(micro) / 1_000_000;
	return { cost, currency: table.currency, priceKind: 'tabelle', priceSource: `runner-tabelle${table.asOf ? ` ${table.asOf}` : ''}`.slice(0, 100) };
}
