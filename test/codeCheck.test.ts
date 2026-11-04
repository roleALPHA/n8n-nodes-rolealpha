import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCode, runCodeTests } from '../lib/codeCheck';

const ok = (code: string, nodeNames: string[] = []) => assert.deepEqual(checkCode(code, { nodeNames }), [], code);
const refused = (code: string, pattern: RegExp) => assert.match(checkCode(code).join('; '), pattern, code);

test('Plain data shaping passes', () => {
	ok(`const out = [];
for (const item of $input.all()) {
	const seen = new Map(Object.entries(item.json));
	const { a, b = 2, ...rest } = item.json;
	out.push({ json: { a, b, rest, c: seen.get('c'), first: [1, 2][0], d: item.json['d'], up: String(a).toUpperCase(), n: Math.max(1, 2), at: new Date(0).toISOString() } });
}
return out.filter(Boolean).map((i) => ({ ...i, keyed: { [i.json.a]: 1 } }));`);
	ok(`function twice(x) { return x * 2; } const r = $('Load').first().json.rows.map(twice); return [{ json: { r } }];`, ['Load']);
	ok(`try { return [{ json: JSON.parse($json.text) }]; } catch (e) { return [{ json: { error: e.message } }]; }`);
	ok(`var total = 0; if (true) { var extra = 1; } for (let i = 0; i < 3; i++) total += i + extra; switch (total) { case 1: { const z = 1; total = z; break; } default: total = 0; } return [{ json: { total } }];`);
});

test('The ways out of the data are refused', () => {
	refused(`return process.env;`, /"process"/);
	refused(`require('fs');`, /"require"/);
	refused(`fetch('https://example.com');`, /"fetch"/);
	refused(`return $env.ZAMMAD_API_TOKEN;`, /"\$env"/);
	refused(`return globalThis;`, /"globalThis"/);
	refused(`eval('1');`, /"eval"/);
	refused(`new Function('return 1')();`, /new with anything but/);
	refused(`return Function('return 1')();`, /"Function"/);
	refused(`return this.helpers;`, /ThisExpression/);
	refused(`import('fs');`, /ImportExpression/);
	refused(`return [].constructor.constructor('return process')();`, /"constructor"/);
	refused(`return [].__proto__;`, /"__proto__"/);
	refused(`const { constructor: c } = []; return c;`, /"constructor"/);
	refused(`return ({ __proto__: null });`, /"__proto__"/);
	refused(`return Object.getPrototypeOf({});`, /getPrototypeOf/);
	refused(`return Object.getOwnPropertyNames({});`, /getOwnPropertyNames/);
	refused(`return Reflect.ownKeys({});`, /"Reflect"/);
	refused(`return new Proxy({}, {});`, /new with anything but/);
	refused(`const f = function () {}; return f.call(null);`, /"call"/);
	refused(`class A {}`, /ClassDeclaration/);
	refused(`return (async () => 1)();`, /async/);
	refused('return String.raw`x`;', /TaggedTemplateExpression/);
	refused(`with ({}) {}`, /does not parse|WithStatement/);
	refused(`return $execution.id;`, /"\$execution"/);
	refused(`return $input.context;`, /\$input\.context/);
	refused(`return Array.prototype;`, /"prototype"/);
	refused(`return Error.captureStackTrace;`, /Error\.captureStackTrace/);
	refused(`return ({ get x() { return 1; } });`, /getter or setter/);
});

test('Dynamic keys are refused, however they are spelled', () => {
	refused(`const k = 'constructor'; return [][k];`, /dynamic key/);
	refused(`return []['constr' + 'uctor'];`, /dynamic key/);
	refused('return []["constructor"];', /"constructor"/);
	refused('return []["c" + "onstructor"]("x");', /dynamic key/);
	refused('const k = "x"; const { [k]: v } = {}; return v;', /dynamic key/);
	refused('return [][`constructor`];', /dynamic key/);
});

test('Aliases and writes to globals do not get past the lists', () => {
	refused(`const E = Error; E.prepareStackTrace = (e, s) => s[0].getFunction(); return new E().stack;`, /passes "Error" around/);
	refused(`Error.prepareStackTrace = () => 1;`, /"prepareStackTrace"/);
	refused(`const O = Object; return O.freeze({});`, /passes "Object" around/);
	refused(`const [O] = [Object]; return O;`, /passes "Object" around/);
	refused(`return ((o) => o.freeze)(Object);`, /passes "Object" around/);
	refused(`JSON = {};`, /assigns to the global "JSON"/);
	refused(`Math.max = () => 1;`, /assigns to the global "Math"/);
	refused(`$input.all = () => [];`, /assigns to the global "\$input"/);
	refused(`({ x: Object.keys } = {});`, /assigns to the global "Object"/);
	refused(`const s = (e) => e.getThis; return s;`, /"getThis"/);
	ok(`$json.seen = true; const row = {}; row.a = 1; return [{ json: { ...$json, ...row, s: [1].map(String), k: Object.keys(row), d: Date.now() > 0, a: Array.isArray([]), n: parseInt('1', 10) } }];`);
});

test('A name is only known in its own block', () => {
	refused(`{ const fetch = 1; } return fetch('x');`, /"fetch"/);
	refused(`if (true) { let process = 1; } return process.env;`, /"process"/);
	refused(`function f(process) { return 1; } return process;`, /"process"/);
	ok(`{ var known = 1; } return [{ json: { known } }];`);
});

test('Other nodes are read by literal name, and only nodes of the workflow', () => {
	assert.match(checkCode(`return $('Elsewhere').all();`, { nodeNames: ['Here'] }).join(), /"Elsewhere"/);
	assert.match(checkCode(`const n = 'Here'; return $(n).all();`, { nodeNames: ['Here'] }).join(), /literal name/);
	assert.match(checkCode(`const d = $; return d('Here');`, { nodeNames: ['Here'] }).join(), /other than as/);
	assert.match(checkCode(`return $('Here').params;`, { nodeNames: ['Here'] }).join(), /only all, first/);
});

test('Size and syntax errors stop the check early', () => {
	assert.match(checkCode('return (').join(), /does not parse/);
	assert.match(checkCode('x'.repeat(9000)).join(), /at most 8000/);
	assert.match(checkCode('').join(), /no code/);
});

test('Tests run the code in both modes and name what differs', () => {
	const all = `return $input.all().map((i) => ({ json: { n: i.json.n * 2 } }));`;
	assert.deepEqual(runCodeTests(all, 'runOnceForAllItems', [{ input: [{ n: 2 }, { n: 3 }], expected: [{ n: 4 }, { n: 6 }] }]), []);
	assert.match(runCodeTests(all, 'runOnceForAllItems', [{ name: 'wrong', input: [{ n: 2 }], expected: [{ n: 5 }] }]).join(), /test "wrong" expected \[\{"n":5\}\] but got \[\{"n":4\}\]/);
	const each = `return { json: { n: $json.n + 1, m: $input.item.json.n } };`;
	assert.deepEqual(runCodeTests(each, 'runOnceForEachItem', [{ input: [{ n: 1 }, { n: 2 }], expected: [{ n: 2, m: 1 }, { n: 3, m: 2 }] }]), []);
	const read = `return [{ json: { total: $('Load').all().length, plain: true } }];`;
	assert.deepEqual(runCodeTests(read, 'runOnceForAllItems', [{ nodes: { Load: [{}, {}] }, expected: [{ total: 2, plain: true }] }]), []);
	assert.deepEqual(runCodeTests(`return [{ plain: 1 }];`, 'runOnceForAllItems', [{ expected: [{ plain: 1 }] }]), [], 'plain objects count as items, as in n8n');
});

test('Tests must exist, and code that throws, returns nothing or never ends fails', () => {
	assert.match(runCodeTests('return [];', 'runOnceForAllItems', undefined).join(), /no test/);
	assert.match(runCodeTests('return [];', 'runOnceForAllItems', []).join(), /no test/);
	assert.match(runCodeTests('return [];', 'runOnceForAllItems', [{}]).join(), /no expected/);
	assert.match(runCodeTests(`throw new Error('boom');`, 'runOnceForAllItems', [{ expected: [] }]).join(), /boom/);
	assert.match(runCodeTests(`return 1;`, 'runOnceForAllItems', [{ expected: [] }]).join(), /no array/);
	assert.match(runCodeTests(`while (true) {}`, 'runOnceForAllItems', [{ expected: [] }]).join(), /timed out/);
});

test('The test run has nothing of the host', () => {
	const probe = `return [{ json: { p: typeof process, r: typeof require } }];`;
	assert.deepEqual(runCodeTests(probe, 'runOnceForAllItems', [{ expected: [{ p: 'undefined', r: 'undefined' }] }]), []);
});
