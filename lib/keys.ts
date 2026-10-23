/**
 * The agent keyring: one credential holds the keys of every agent this n8n runs.
 * A new agent runs as soon as its key is added — no new credential, no new workflow.
 */

export interface AgentKey {
	agentUuid: string;
	key: string;
	label: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Accepts `{ "<agentUuid>": "agt_…" }` or `[{ "agentUuid": "…", "key": "agt_…", "label": "…" }]`. */
export function parseKeyring(raw: string): AgentKey[] {
	const text = (raw ?? '').trim();
	if (text === '') return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error('Agent keys must be JSON');
	}
	const entries: AgentKey[] = Array.isArray(parsed)
		? parsed.map((e) => {
				const o = (e ?? {}) as Record<string, unknown>;
				return { agentUuid: String(o.agentUuid ?? ''), key: String(o.key ?? ''), label: typeof o.label === 'string' ? o.label : null };
			})
		: Object.entries((parsed ?? {}) as Record<string, unknown>).map(([agentUuid, key]) => ({
				agentUuid,
				key: String(key ?? ''),
				label: null,
			}));
	const seen = new Set<string>();
	for (const e of entries) {
		e.agentUuid = e.agentUuid.trim().toLowerCase();
		e.key = e.key.trim();
		if (!UUID.test(e.agentUuid)) throw new Error(`Not an agent UUID: "${e.agentUuid}"`);
		if (!e.key.startsWith('agt_')) throw new Error(`Key for ${e.agentUuid} does not start with agt_`);
		if (seen.has(e.agentUuid)) throw new Error(`Agent ${e.agentUuid} is listed twice`);
		seen.add(e.agentUuid);
	}
	return entries;
}

export function keyFor(keyring: AgentKey[], agentUuid: string): string {
	const wanted = String(agentUuid ?? '').trim().toLowerCase();
	const hit = keyring.find((k) => k.agentUuid === wanted);
	if (!hit) throw new Error(`No key configured for agent ${wanted || '(empty)'}`);
	return hit.key;
}
