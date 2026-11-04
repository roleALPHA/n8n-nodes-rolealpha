/**
 * Code nodes a model writes. A model's code is pure data shaping: it may read its input and
 * the output of nodes in the same workflow, and return items. Everything else is refused
 * by an allow list on the syntax tree, not by searching for bad words: an unknown syntax
 * form or an unknown global fails. Dynamic keys (`row[key]`) fail too, because they are the
 * way around any list of forbidden properties; `new Map(Object.entries(row)).get(key)` does
 * the same without reaching `constructor`.
 *
 * This is one layer, not the sandbox: n8n has to block environment access for Code nodes
 * and a person has to approve the code.
 */

import { parse, type Node as AcornNode } from 'acorn';
import { runInNewContext } from 'vm';
import { canonicalJson } from './seal';

type Ast = AcornNode & Record<string, any>;

export type CodeMode = 'runOnceForAllItems' | 'runOnceForEachItem';

export interface CodeTest {
	name?: string;
	/** The `json` of each input item. */
	input?: unknown[];
	/** The `json` of each item of other nodes, by node name, for `$('Node')`. */
	nodes?: Record<string, unknown[]>;
	/** The `json` of each expected output item. */
	expected: unknown[];
}

export const MAX_CODE_CHARS = 8000;
const MAX_TESTS = 10;
const TEST_TIMEOUT_MS = 1000;

const SYNTAX = new Set([
	'Program', 'ExpressionStatement', 'BlockStatement', 'EmptyStatement', 'VariableDeclaration', 'VariableDeclarator',
	'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ReturnStatement', 'IfStatement', 'ForStatement',
	'ForOfStatement', 'ForInStatement', 'WhileStatement', 'DoWhileStatement', 'BreakStatement', 'ContinueStatement',
	'SwitchStatement', 'SwitchCase', 'TryStatement', 'CatchClause', 'ThrowStatement', 'Literal', 'Identifier', 'TemplateLiteral',
	'TemplateElement', 'ArrayExpression', 'ObjectExpression', 'Property', 'SpreadElement', 'RestElement', 'ArrayPattern',
	'ObjectPattern', 'AssignmentPattern', 'MemberExpression', 'ChainExpression', 'CallExpression', 'NewExpression',
	'UnaryExpression', 'UpdateExpression', 'BinaryExpression', 'LogicalExpression', 'AssignmentExpression',
	'ConditionalExpression', 'SequenceExpression',
]);

/** Globals the code may name, with the static members it may use where that matters. */
const GLOBALS: Record<string, string[] | null> = {
	JSON: ['parse', 'stringify'],
	Math: null,
	Date: ['now', 'parse', 'UTC'],
	Array: ['from', 'isArray', 'of'],
	Object: ['keys', 'values', 'entries', 'fromEntries', 'assign'],
	String: ['fromCharCode'],
	Number: null,
	Boolean: [],
	RegExp: [],
	Map: [],
	Set: [],
	Error: [],
	parseInt: [],
	parseFloat: [],
	isNaN: [],
	isFinite: [],
	encodeURIComponent: [],
	decodeURIComponent: [],
	undefined: [],
	NaN: [],
	Infinity: [],
	$input: ['all', 'first', 'last', 'item'],
	$json: null,
};
const NEWABLE = new Set(['Map', 'Set', 'Date', 'RegExp', 'Error']);
/** Only these may be passed around by name, as in `.map(String)`; an alias of the others would slip past their list of statics. */
const PASSABLE = new Set(['String', 'Number', 'Boolean', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'undefined', 'NaN', 'Infinity', '$input', '$json']);
const NODE_READS = new Set(['all', 'first', 'last', 'item']);

/** Property names that reach the runtime instead of data, wherever they appear. */
const DENIED = new Set([
	'constructor', '__proto__', 'prototype', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__',
	'getPrototypeOf', 'setPrototypeOf', 'defineProperty', 'defineProperties', 'getOwnPropertyDescriptor',
	'getOwnPropertyDescriptors', 'getOwnPropertyNames', 'getOwnPropertySymbols', 'callee', 'caller', 'bind', 'call', 'apply',
	'helpers', 'getCredentials', 'env', 'mainModule', 'prepareStackTrace', 'captureStackTrace', 'stackTraceLimit', 'getFunction', 'getThis',
]);

class Scope {
	private readonly names = new Set<string>();
	constructor(readonly parent: Scope | null, readonly isFunction: boolean) {}
	add(name: string): void {
		this.names.add(name);
	}
	has(name: string): boolean {
		return this.names.has(name) || (this.parent?.has(name) ?? false);
	}
}

function patternNames(pattern: Ast | null, out: string[] = []): string[] {
	if (!pattern) return out;
	if (pattern.type === 'Identifier') out.push(pattern.name);
	else if (pattern.type === 'ObjectPattern') pattern.properties.forEach((p: Ast) => patternNames(p.type === 'RestElement' ? p.argument : p.value, out));
	else if (pattern.type === 'ArrayPattern') pattern.elements.forEach((e: Ast | null) => patternNames(e, out));
	else if (pattern.type === 'AssignmentPattern') patternNames(pattern.left, out);
	else if (pattern.type === 'RestElement') patternNames(pattern.argument, out);
	return out;
}

const isNode = (v: unknown): v is Ast => !!v && typeof v === 'object' && typeof (v as { type?: unknown }).type === 'string';

function childrenOf(node: Ast): Ast[] {
	const out: Ast[] = [];
	for (const [key, value] of Object.entries(node)) {
		if (key === 'type' || key === 'start' || key === 'end') continue;
		if (Array.isArray(value)) value.forEach((v) => isNode(v) && out.push(v));
		else if (isNode(value)) out.push(value);
	}
	return out;
}

/** `var` belongs to the enclosing function, wherever it is written. */
function hoistVars(node: Ast, scope: Scope): void {
	for (const child of childrenOf(node)) {
		if (/Function/.test(child.type)) continue;
		if (child.type === 'VariableDeclaration' && child.kind === 'var') child.declarations.forEach((d: Ast) => patternNames(d.id).forEach((n) => scope.add(n)));
		hoistVars(child, scope);
	}
}

/** let, const and functions belong to the block they are written in. */
function declareBlock(statements: Ast[], scope: Scope): void {
	for (const s of statements) {
		if (s.type === 'FunctionDeclaration' && s.id) scope.add(s.id.name);
		if (s.type === 'VariableDeclaration' && s.kind !== 'var') s.declarations.forEach((d: Ast) => patternNames(d.id).forEach((n) => scope.add(n)));
	}
}

export function checkCode(code: string, opts: { nodeNames?: Iterable<string> } = {}): string[] {
	const problems: string[] = [];
	const refuse = (message: string) => void (problems.includes(message) || problems.push(message));
	if (typeof code !== 'string' || code.trim() === '') return ['has no code'];
	if (code.length > MAX_CODE_CHARS) return [`has ${code.length} characters of code; at most ${MAX_CODE_CHARS} are allowed`];
	let ast: Ast;
	try {
		ast = parse(code, { ecmaVersion: 2023, sourceType: 'script', allowReturnOutsideFunction: true }) as Ast;
	} catch (error) {
		return [`does not parse: ${(error as Error).message}`];
	}
	const nodeNames = new Set(opts.nodeNames ?? []);

	const denied = (name: unknown, where: string) => {
		if (typeof name === 'string' && DENIED.has(name)) refuse(`uses ${where} "${name}", which is not allowed`);
	};

	const walkPattern = (p: Ast | null, scope: Scope): void => {
		if (!p) return;
		if (p.type === 'ObjectPattern') {
			for (const prop of p.properties as Ast[]) {
				if (prop.type === 'RestElement') {
					walkPattern(prop.argument, scope);
					continue;
				}
				if (prop.computed) refuse('uses a dynamic key in a destructuring, which is not allowed');
				denied(prop.key.name ?? prop.key.value, 'the property');
				walkPattern(prop.value, scope);
			}
		} else if (p.type === 'ArrayPattern') p.elements.forEach((e: Ast | null) => walkPattern(e, scope));
		else if (p.type === 'AssignmentPattern') {
			walkPattern(p.left, scope);
			walk(p.right, scope);
		} else if (p.type === 'RestElement') walkPattern(p.argument, scope);
		else {
			// An identifier or a member on the left of an assignment: only what the code owns, or its input.
			let root = p;
			while (root.type === 'MemberExpression') root = root.object;
			if (root.type === 'Identifier' && !scope.has(root.name) && root.name !== '$json') refuse(`assigns to the global "${root.name}", which is not allowed`);
			walk(p, scope);
		}
	};

	const walkFunction = (fn: Ast, scope: Scope): void => {
		if (fn.async || fn.generator) refuse('uses an async or generator function, which is not allowed');
		const inner = new Scope(scope, true);
		if (fn.type === 'FunctionExpression' && fn.id) inner.add(fn.id.name);
		fn.params.forEach((p: Ast) => patternNames(p).forEach((n) => inner.add(n)));
		fn.params.forEach((p: Ast) => walkPattern(p, inner));
		hoistVars(fn.body, inner);
		if (fn.body.type === 'BlockStatement') {
			declareBlock(fn.body.body, inner);
			fn.body.body.forEach((s: Ast) => walk(s, inner));
		} else walk(fn.body, inner);
	};

	const known = (name: string) => {
		if (!Object.prototype.hasOwnProperty.call(GLOBALS, name)) refuse(`uses "${name}", which is not allowed`);
	};

	const isNodeRead = (n: Ast): boolean => n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === '$';

	const walkMember = (m: Ast, scope: Scope): void => {
		if (m.computed) {
			const key = m.property as Ast;
			const literal = key.type === 'Literal' && (typeof key.value === 'number' || typeof key.value === 'string');
			if (!literal) refuse('uses a dynamic key (obj[key]), which is not allowed; use for...of, Object.entries or a Map');
			else denied(key.value, 'the property');
		} else {
			denied(m.property.name, 'the property');
		}
		const name = m.computed ? (m.property as Ast).value : m.property.name;
		if (isNodeRead(m.object) && !NODE_READS.has(String(name))) refuse(`reads "${name}" of another node; only all, first, last and item are allowed`);
		if (m.object.type === 'Identifier' && !scope.has(m.object.name)) {
			// Instances are checked by DENIED; only the statics of a global are listed.
			const allowed = GLOBALS[m.object.name];
			if (Array.isArray(allowed) && !allowed.includes(String(name))) refuse(`uses ${m.object.name}.${String(name)}, which is not allowed`);
		}
		if (m.object.type !== 'Identifier' || scope.has(m.object.name)) walk(m.object, scope);
		else known(m.object.name);
	};

	function walk(node: Ast | null | undefined, scope: Scope): void {
		if (!node) return;
		if (!SYNTAX.has(node.type)) return refuse(`uses ${node.type}, which is not allowed`);
		switch (node.type) {
			case 'Identifier':
				if (node.name === '$') return refuse('uses $ other than as $(\'Node name\')');
				if (scope.has(node.name)) return;
				known(node.name);
				if (Object.prototype.hasOwnProperty.call(GLOBALS, node.name) && !PASSABLE.has(node.name)) refuse(`passes "${node.name}" around, which is not allowed; use it directly`);
				return;
			case 'Program':
			case 'BlockStatement': {
				const inner = new Scope(scope, false);
				declareBlock(node.body, inner);
				node.body.forEach((s: Ast) => walk(s, inner));
				return;
			}
			case 'FunctionDeclaration':
			case 'FunctionExpression':
			case 'ArrowFunctionExpression':
				return walkFunction(node, scope);
			case 'VariableDeclarator':
				walkPattern(node.id, scope);
				return walk(node.init, scope);
			case 'AssignmentExpression':
				walkPattern(node.left, scope);
				return walk(node.right, scope);
			case 'ForStatement':
			case 'ForOfStatement':
			case 'ForInStatement': {
				if (node.await) refuse('uses for await, which is not allowed');
				const inner = new Scope(scope, false);
				const head = node.init ?? node.left;
				if (head?.type === 'VariableDeclaration' && head.kind !== 'var') declareBlock([head], inner);
				childrenOf(node).forEach((c) => walk(c, inner));
				return;
			}
			case 'SwitchStatement': {
				walk(node.discriminant, scope);
				const inner = new Scope(scope, false);
				node.cases.forEach((c: Ast) => declareBlock(c.consequent, inner));
				node.cases.forEach((c: Ast) => {
					walk(c.test, inner);
					c.consequent.forEach((s: Ast) => walk(s, inner));
				});
				return;
			}
			case 'CatchClause': {
				const inner = new Scope(scope, false);
				patternNames(node.param).forEach((n) => inner.add(n));
				walkPattern(node.param, inner);
				return walk(node.body, inner);
			}
			case 'MemberExpression':
				return walkMember(node, scope);
			case 'Property':
				if (node.kind !== 'init') refuse('uses a getter or setter, which is not allowed');
				if (node.computed) walk(node.key, scope);
				else denied(node.key.name ?? node.key.value, 'the property');
				return walk(node.value, scope);
			case 'CallExpression':
				if (isNodeRead(node)) {
					const arg = node.arguments[0] as Ast | undefined;
					if (node.arguments.length !== 1 || arg?.type !== 'Literal' || typeof arg.value !== 'string') return refuse('uses $() with anything but the literal name of a node');
					if (!nodeNames.has(arg.value)) refuse(`reads node "${arg.value}", which is not in this workflow`);
					return;
				}
				if (node.callee.type === 'Identifier' && !scope.has(node.callee.name)) {
					if (node.callee.name === '$') return refuse('uses $ other than as $(\'Node name\')');
					known(node.callee.name);
				} else walk(node.callee, scope);
				node.arguments.forEach((a: Ast) => walk(a, scope));
				return;
			case 'NewExpression':
				if (node.callee.type !== 'Identifier' || !NEWABLE.has(node.callee.name) || scope.has(node.callee.name)) return refuse('uses new with anything but Map, Set, Date, RegExp or Error');
				node.arguments.forEach((a: Ast) => walk(a, scope));
				return;
			case 'BreakStatement':
			case 'ContinueStatement':
				if (node.label) refuse('uses a label, which is not allowed');
				return;
			default:
				childrenOf(node).forEach((c) => walk(c, scope));
		}
	}

	const root = new Scope(null, true);
	hoistVars(ast, root);
	walk(ast, root);
	return problems;
}

/** Items as n8n takes them from a Code node: `{ json }` or the plain object. */
function jsonOf(item: unknown): unknown {
	return item && typeof item === 'object' && 'json' in (item as object) ? (item as { json: unknown }).json : item;
}

const SETUP = `
const __data = JSON.parse(__payload);
const __wrap = (rows) => (rows || []).map((json) => ({ json }));
const __reader = (items) => ({ all: () => items, first: () => items[0], last: () => items[items.length - 1], get item() { return items[0]; } });
const __nodes = Object.fromEntries(Object.entries(__data.nodes || {}).map(([k, v]) => [k, __reader(__wrap(v))]));
const $ = (name) => __nodes[name] || __reader([]);
`;

/** Runs code that passed checkCode against the model's own test cases. */
export function runCodeTests(code: string, mode: CodeMode, tests: unknown): string[] {
	if (!Array.isArray(tests) || tests.length === 0) return ['has no test; add at least one under codeTests'];
	if (tests.length > MAX_TESTS) return [`has ${tests.length} tests; at most ${MAX_TESTS} are allowed`];
	const problems: string[] = [];
	tests.forEach((raw, index) => {
		const test = (raw && typeof raw === 'object' ? raw : {}) as CodeTest;
		const label = `test "${test.name ?? index + 1}"`;
		if (!Array.isArray(test.expected)) return void problems.push(`${label} has no expected output`);
		const body =
			mode === 'runOnceForEachItem'
				? `__wrap(__data.input).flatMap((__item) => { const $json = __item.json; const $input = { item: __item }; const __out = (function () {\n${code}\n})(); return __out === undefined || __out === null ? [] : [__out]; })`
				: `(() => { const __items = __wrap(__data.input); const $input = __reader(__items); const $json = __items[0] ? __items[0].json : undefined; return (function () {\n${code}\n})(); })()`;
		try {
			const payload = JSON.stringify({ input: test.input ?? [], nodes: test.nodes ?? {} });
			const text = runInNewContext(`${SETUP}\nJSON.stringify(${body})`, { __payload: payload }, { timeout: TEST_TIMEOUT_MS }) as string | undefined;
			const result = text === undefined ? undefined : (JSON.parse(text) as unknown);
			if (!Array.isArray(result)) return void problems.push(`${label} returned no array of items`);
			const got = canonicalJson(result.map(jsonOf));
			const want = canonicalJson(test.expected.map(jsonOf));
			if (got !== want) problems.push(`${label} expected ${want.slice(0, 300)} but got ${got.slice(0, 300)}`);
		} catch (error) {
			problems.push(`${label} failed: ${(error as Error).message}`);
		}
	});
	return problems;
}
