/** Verification of roleALPHA context webhooks (`X-RA-Signature: sha256=<hex>`). */

import { createHmac, timingSafeEqual } from 'crypto';

export interface ContextChangedEvent {
	event: 'context.changed';
	agentUuid: string;
	contextVersion: string;
	changedAt: string;
}

export function signBody(secret: string, rawBody: Buffer | string): string {
	return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

export function verifySignature(secrets: string[], rawBody: Buffer | string, signature: unknown): boolean {
	const given = typeof signature === 'string' ? signature.trim().toLowerCase() : '';
	if (!/^sha256=[0-9a-f]{64}$/.test(given)) return false;
	const actual = Buffer.from(given, 'utf8');
	return secrets
		.filter((s) => typeof s === 'string' && s !== '')
		.some((secret) => {
			const expected = Buffer.from(signBody(secret, rawBody), 'utf8');
			return expected.length === actual.length && timingSafeEqual(expected, actual);
		});
}

/** Secrets may be one string, a JSON list, or a JSON map agentUuid → secret. */
export function parseSecrets(raw: string, agentUuid?: string): string[] {
	const text = (raw ?? '').trim();
	if (text === '') return [];
	if (!text.startsWith('{') && !text.startsWith('[')) return [text];
	const parsed = JSON.parse(text) as unknown;
	if (Array.isArray(parsed)) return parsed.filter((s): s is string => typeof s === 'string');
	const map = parsed as Record<string, unknown>;
	if (agentUuid && typeof map[agentUuid] === 'string') return [map[agentUuid] as string];
	return agentUuid ? [] : Object.values(map).filter((s): s is string => typeof s === 'string');
}

export function parseEvent(body: unknown): ContextChangedEvent | null {
	const o = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
	if (o.event !== 'context.changed' || typeof o.agentUuid !== 'string') return null;
	return {
		event: 'context.changed',
		agentUuid: o.agentUuid,
		contextVersion: String(o.contextVersion ?? ''),
		changedAt: String(o.changedAt ?? ''),
	};
}
