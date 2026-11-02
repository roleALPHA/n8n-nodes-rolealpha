/**
 * Approval tokens: a link that says who may decide what about which draft, signed with the
 * seal key. The link itself is the proof, so it works without a single sign-on proxy.
 *
 *   at1.<base64url claims>.<base64url HMAC-SHA256>
 *
 * A token is bound to one draft, its content hash, one person and one decision, and it
 * expires. It can be used once: applying or discarding removes the draft, and a second
 * use finds no draft any more. Whether the person may still decide is checked at use,
 * not when the token is issued.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { canonicalJson } from './seal';
import { normalizeEmail } from './graph';

export type Decision = 'approve' | 'reject';

export interface TokenClaims {
	draftId: string;
	contentHash: string;
	approver: string;
	decision: Decision;
	/** Expiry in seconds since the epoch. */
	exp: number;
}

export interface TokenCheck {
	valid: boolean;
	reason: string;
	claims: TokenClaims | null;
}

const PREFIX = 'at1';
/** Keeps a token signature from ever matching a seal made with the same key. */
const PURPOSE = 'rolealpha-approval-token';
/** Only these characters can occur, so a valid token is safe in a URL and in HTML. */
export const TOKEN_PATTERN = /^at1\.[A-Za-z0-9_-]{16,2048}\.[A-Za-z0-9_-]{43}$/;
const MAX_HOURS = 24 * 30;

function requireKey(key: string): void {
	if (typeof key !== 'string' || key.length < 32) throw new Error('The seal key must be at least 32 characters long');
}

function mac(key: string, body: string): string {
	return createHmac('sha256', key).update(`${PURPOSE}:${body}`, 'utf8').digest('base64url');
}

export function issueToken(
	key: string,
	input: { draftId: string; contentHash: string; approver: string; decision: Decision },
	opts: { validHours?: number; now?: Date } = {},
): { token: string; expiresAt: string } {
	requireKey(key);
	const draftId = String(input.draftId ?? '').trim();
	const contentHash = String(input.contentHash ?? '').trim();
	const approver = normalizeEmail(input.approver);
	if (!draftId) throw new Error('A token needs the draft ID');
	if (!contentHash) throw new Error('A token needs the content hash of the draft');
	if (!approver.includes('@')) throw new Error('A token needs the approver address');
	if (input.decision !== 'approve' && input.decision !== 'reject') throw new Error('The decision is approve or reject');
	const hours = Math.min(Math.max(Number(opts.validHours ?? 168) || 168, 1), MAX_HOURS);
	const exp = Math.floor((opts.now ?? new Date()).getTime() / 1000) + Math.round(hours * 3600);
	const claims: TokenClaims = { draftId, contentHash, approver, decision: input.decision, exp };
	const body = Buffer.from(canonicalJson(claims), 'utf8').toString('base64url');
	return { token: `${PREFIX}.${body}.${mac(key, body)}`, expiresAt: new Date(exp * 1000).toISOString() };
}

export function verifyToken(key: string, token: unknown, opts: { now?: Date } = {}): TokenCheck {
	requireKey(key);
	const value = typeof token === 'string' ? token.trim() : '';
	if (!TOKEN_PATTERN.test(value)) return { valid: false, reason: 'No valid approval token', claims: null };
	const [, body, sig] = value.split('.');
	const a = Buffer.from(sig, 'utf8');
	const b = Buffer.from(mac(key, body), 'utf8');
	if (a.length !== b.length || !timingSafeEqual(a, b)) return { valid: false, reason: 'The token was not issued here or was changed', claims: null };
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
	} catch {
		return { valid: false, reason: 'The token cannot be read', claims: null };
	}
	const claims: TokenClaims = {
		draftId: String(raw.draftId ?? ''),
		contentHash: String(raw.contentHash ?? ''),
		approver: String(raw.approver ?? ''),
		decision: raw.decision as Decision,
		exp: Number(raw.exp),
	};
	if (!claims.draftId || !claims.contentHash || !claims.approver.includes('@') || !['approve', 'reject'].includes(claims.decision) || !Number.isFinite(claims.exp)) {
		return { valid: false, reason: 'The token is incomplete', claims: null };
	}
	if (claims.exp * 1000 <= (opts.now ?? new Date()).getTime()) return { valid: false, reason: 'The link has expired', claims };
	return { valid: true, reason: 'Token matches', claims };
}
