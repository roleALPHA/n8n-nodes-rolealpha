/**
 * Approval seals: proof that exactly this version was approved by exactly this person.
 * Whoever sends something out recomputes the seal over the current version and
 * stops if it does not match.
 *
 *   v3  HMAC-SHA256 over canonical JSON ['v3', type, fields, approver]
 *   v2  legacy 64-bit hash written by code nodes without crypto (verify only)
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { normalizeEmail } from './graph';

export interface SealCheck {
	valid: boolean;
	version: 'v2' | 'v3' | null;
	reason: string;
}

/** JSON with sorted object keys so the seal does not depend on field order. */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	const o = value as Record<string, unknown>;
	const keys = Object.keys(o)
		.filter((k) => o[k] !== undefined)
		.sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

function requireKey(key: string): void {
	if (typeof key !== 'string' || key.length < 32) throw new Error('The seal key must be at least 32 characters long');
}

export function signSeal(key: string, type: string, fields: unknown, approver: string): string {
	requireKey(key);
	const email = normalizeEmail(approver);
	if (!email.includes('@')) throw new Error('A seal needs the approver address');
	const payload = canonicalJson(['v3', String(type), fields ?? null, email]);
	return `v3:${createHmac('sha256', key).update(payload, 'utf8').digest('hex')}`;
}

/** The v2 hash exactly as the existing code nodes compute it. */
export function legacySeal(key: string, type: string, fields: unknown, approver: string): string {
	const s = JSON.stringify(['v2', key, type, fields, String(approver || '').trim().toLowerCase()]);
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 2654435761);
		h2 = Math.imul(h2 ^ c, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return 'v2:' + (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

function same(a: string, b: string): boolean {
	const x = Buffer.from(a, 'utf8');
	const y = Buffer.from(b, 'utf8');
	return x.length === y.length && timingSafeEqual(x, y);
}

export function verifySeal(
	keys: { key: string; legacyKey?: string },
	seal: unknown,
	type: string,
	fields: unknown,
	approver: string,
): SealCheck {
	const value = typeof seal === 'string' ? seal.trim() : '';
	if (value === '') return { valid: false, version: null, reason: 'No seal present' };
	const email = normalizeEmail(approver);
	if (!email.includes('@')) return { valid: false, version: null, reason: 'No approver address present' };
	if (value.startsWith('v3:')) {
		const ok = same(value, signSeal(keys.key, type, fields, email));
		return { valid: ok, version: 'v3', reason: ok ? 'Seal matches' : 'Changed after approval' };
	}
	if (value.startsWith('v2:')) {
		if (!keys.legacyKey) return { valid: false, version: 'v2', reason: 'Legacy seal, but no legacy key configured' };
		const ok = same(value, legacySeal(keys.legacyKey, type, fields, email));
		return { valid: ok, version: 'v2', reason: ok ? 'Legacy seal matches' : 'Changed after approval' };
	}
	return { valid: false, version: null, reason: 'Unknown seal format' };
}
