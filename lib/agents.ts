/**
 * Agents over the roleALPHA MCP endpoint. With one OAuth2 connection every agent
 * of the organisation is found and run, so a new agent needs no per-agent key.
 */

import type { McpClient } from './mcp';
import type { ContextBundle } from './prompt';

export type ContextView = 'agent' | 'caller';

export interface AgentEntry {
	agentUuid: string;
	agentName: string;
	customId: string | null;
	status: string | null;
}

const PAGE_SIZE = 200;
const MAX_PAGES = 50;

function str(value: unknown): string | null {
	if (typeof value === 'string') return value.trim() === '' ? null : value.trim();
	if (typeof value === 'number') return String(value);
	return null;
}

/** Status comes from `status`, else from the last part of the summary ("Name | active"). */
export function agentStatus(raw: Record<string, unknown>): string | null {
	const direct = str(raw.status);
	if (direct) return direct.toLowerCase();
	const summary = str(raw.summary);
	if (!summary || !summary.includes('|')) return null;
	return str(summary.split('|').pop())?.toLowerCase() ?? null;
}

function toEntry(raw: Record<string, unknown>): AgentEntry | null {
	const uuid = str(raw.uuid ?? raw.entityUuid ?? raw.id);
	if (!uuid) return null;
	return {
		agentUuid: uuid.toLowerCase(),
		agentName: str(raw.name) ?? '',
		customId: str(raw.customerId ?? raw.customer_id ?? raw.customId),
		status: agentStatus(raw),
	};
}

/** All agents of the organisation, paged through search_agents. */
export async function listAgents(client: McpClient, organisation: string): Promise<AgentEntry[]> {
	const out: AgentEntry[] = [];
	const seen = new Set<string>();
	let offset = 0;
	for (let page = 0; page < MAX_PAGES; page++) {
		const res = (await client.callTool('search_agents', { query: '', organisation, limit: PAGE_SIZE, offset })) as Record<string, unknown> | unknown[];
		const list = Array.isArray(res) ? res : ((res?.agents ?? res?.results ?? res?.entities ?? []) as unknown[]);
		for (const raw of list) {
			const entry = raw && typeof raw === 'object' ? toEntry(raw as Record<string, unknown>) : null;
			if (entry && !seen.has(entry.agentUuid)) {
				seen.add(entry.agentUuid);
				out.push(entry);
			}
		}
		if (Array.isArray(res) || !res?.hasMore) return out;
		const next = Number(res.nextOffset);
		offset = Number.isFinite(next) && next > offset ? next : offset + list.length;
		if (list.length === 0) break;
	}
	throw new Error(`search_agents did not finish after ${MAX_PAGES} pages`);
}

/** The bundle may come bare, wrapped in {bundle} or as one of several content parts. */
function findBundle(value: unknown): ContextBundle | null {
	if (Array.isArray(value)) {
		for (const v of value) {
			const b = findBundle(v);
			if (b) return b;
		}
		return null;
	}
	if (!value || typeof value !== 'object') return null;
	const obj = value as Record<string, unknown>;
	if (obj.agent && typeof obj.agent === 'object') return obj as unknown as ContextBundle;
	return obj.bundle ? findBundle(obj.bundle) : null;
}

/** The context bundle of one agent; view "agent" is exactly what the agent receives over its own key. */
export async function getAgentContext(client: McpClient, organisation: string, agentUuid: string, view: ContextView = 'agent'): Promise<ContextBundle> {
	const res = await client.callTool('get_agent_context', { agent_uuid: agentUuid, organisation, view });
	const bundle = findBundle(res);
	if (!bundle) {
		const raw = typeof res === 'string' ? res : JSON.stringify(res);
		throw new Error(`get_agent_context returned no agent for ${agentUuid}: ${String(raw).slice(0, 400)}`);
	}
	return { ...bundle, guardrails: bundle.guardrails ?? [], context: bundle.context ?? [] };
}
