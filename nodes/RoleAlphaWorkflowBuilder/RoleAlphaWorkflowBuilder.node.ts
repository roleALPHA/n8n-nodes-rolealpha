import type { IDataObject, IExecuteFunctions, INodeExecutionData, INodeProperties, INodeType, INodeTypeDescription } from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { McpClient, type HttpReply } from '../../lib/mcp';
import { McpGraphSource } from '../../lib/graph';
import { detectChanges, ENTITY_TYPES, listIndex, readSnapshots, type EntityChange, type IndexEntry } from '../../lib/changes';
import {
	applyDraft,
	buildPlanInput,
	checkPlan,
	DEFAULT_NODE_TYPES,
	discardDraft,
	DRAFT_TAG,
	draftHash,
	draftWorkflow,
	entityContext,
	MANAGED_TAG,
	N8nApi,
	parseAnswer,
	summarizeWorkflows,
	type N8nWorkflow,
	type PlanCheck,
} from '../../lib/workflows';
import { issueToken, verifyToken } from '../../lib/approvalToken';

const show = (operation: string[]) => ({ show: { operation } });
const MCP_OPS = ['detectChanges', 'propose'];
const N8N_OPS = ['listWorkflows', 'propose', 'createDraft', 'applyDraft', 'discardDraft'];
const TOKEN_OPS = ['issueTokens', 'verifyToken'];

const properties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		options: [
			{ name: 'Detect Changes', value: 'detectChanges', action: 'Detect new, changed and removed entities', description: 'Compares the roleALPHA graph with the stored snapshot rows' },
			{ name: 'List Workflows', value: 'listWorkflows', action: 'List managed workflows', description: 'The n8n workflows bound to roleALPHA entities, with their credentials' },
			{ name: 'Propose', value: 'propose', action: 'Propose a workflow change with a model', description: 'Asks the attached model what a change means for the workflows and checks the answer' },
			{ name: 'Create Draft', value: 'createDraft', action: 'Create an inactive draft from a proposal', description: 'Stores a checked proposal as an inactive draft workflow that waits for approval' },
			{ name: 'Apply Draft', value: 'applyDraft', action: 'Apply an approved draft', description: 'Creates, updates or deactivates the workflow; refuses if the draft or the target changed' },
			{ name: 'Discard Draft', value: 'discardDraft', action: 'Discard a rejected draft', description: 'Deletes a draft; refuses anything that is not a draft' },
			{ name: 'Issue Approval Tokens', value: 'issueTokens', action: 'Issue approve and reject links for one person', description: 'Signed one-time tokens bound to the draft, its hash, the person and the decision' },
			{ name: 'Verify Approval Token', value: 'verifyToken', action: 'Verify the token of an approval link', description: 'Returns draft, hash, person and decision of a valid token; refuses changed or expired ones' },
		],
		default: 'detectChanges',
	},
	{
		displayName: 'MCP Endpoint URL',
		name: 'endpointUrl',
		type: 'string',
		default: 'https://rolealpha.app/api/mcp',
		required: true,
		displayOptions: show(MCP_OPS),
	},
	{
		displayName: 'Organisation',
		name: 'organisation',
		type: 'string',
		default: '',
		required: true,
		description: 'Organisation (tenant) name or ID as roleALPHA knows it',
		displayOptions: show(MCP_OPS),
	},

	// ---------------------------------------------------------------- detect
	{
		displayName: 'Entity Types',
		name: 'entityTypes',
		type: 'multiOptions',
		options: ENTITY_TYPES.map((t) => ({ name: t.charAt(0).toUpperCase() + t.slice(1), value: t })),
		default: ['process', 'role', 'agent'],
		description: 'Entity types to watch. Rows of other types in the snapshot are left alone.',
		displayOptions: show(['detectChanges']),
	},
	{
		displayName: 'Snapshot Rows',
		name: 'snapshotRows',
		type: 'json',
		default: '[]',
		description: 'All stored rows (uuid, entity_type, name, custom_id, fingerprint, fields, edges, seen_at), e.g. from a data table. Empty on the first run: then the snapshot is stored and nothing is reported.',
		displayOptions: show(['detectChanges']),
	},
	{
		displayName: 'Options',
		name: 'detectOptions',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: show(['detectChanges']),
		options: [
			{
				displayName: 'Max Entities',
				name: 'maxEntities',
				type: 'number',
				default: 500,
				description: 'Fail when the watched types hold more entities; every entity costs two reads per run',
			},
			{
				displayName: 'Report First Run',
				name: 'reportBaseline',
				type: 'boolean',
				default: false,
				description: 'Whether every entity counts as created when no rows are stored yet',
			},
			{
				displayName: 'Parallel Reads',
				name: 'concurrency',
				type: 'number',
				default: 4,
				typeOptions: { minValue: 1, maxValue: 10 },
			},
		],
	},

	// ---------------------------------------------------------------- propose
	{
		displayName: 'Change',
		name: 'change',
		type: 'json',
		default: '={{ $json }}',
		required: true,
		description: 'One change from Detect Changes',
		displayOptions: show(['propose']),
	},
	{
		displayName: 'Allowed Node Types',
		name: 'nodeTypes',
		type: 'string',
		typeOptions: { rows: 4 },
		default: DEFAULT_NODE_TYPES.join(', '),
		description: 'Comma-separated n8n node types a proposal may use. Anything else is refused.',
		displayOptions: show(['propose']),
	},
	{
		displayName: 'Extra Rules',
		name: 'extraRules',
		type: 'string',
		typeOptions: { rows: 4 },
		default: '',
		description: 'One rule per line, e.g. which systems and collections exist',
		displayOptions: show(['propose']),
	},
	{
		displayName: 'Attempts',
		name: 'maxAttempts',
		type: 'number',
		default: 2,
		typeOptions: { minValue: 1, maxValue: 5 },
		description: 'How often the model may answer again after its answer failed the check',
		displayOptions: show(['propose']),
	},

	// ---------------------------------------------------------------- drafts
	{
		displayName: 'Proposal',
		name: 'proposal',
		type: 'json',
		default: '={{ $json }}',
		required: true,
		description: 'The output of Propose',
		displayOptions: show(['createDraft']),
	},
	{
		displayName: 'Draft ID',
		name: 'draftId',
		type: 'string',
		default: '',
		required: true,
		displayOptions: show(['applyDraft', 'discardDraft', 'issueTokens']),
	},
	{
		displayName: 'Content Hash',
		name: 'contentHash',
		type: 'string',
		default: '={{ $json.contentHash }}',
		required: true,
		description: 'The contentHash from Create Draft; the token is valid only for exactly this content',
		displayOptions: show(['issueTokens']),
	},
	{
		displayName: 'Approver',
		name: 'approver',
		type: 'string',
		default: '={{ $json.email }}',
		required: true,
		placeholder: 'name@example.com',
		description: 'The person the links are for. Whether they may decide is checked again when they use the link.',
		displayOptions: show(['issueTokens']),
	},
	{
		displayName: 'Valid For (Hours)',
		name: 'validHours',
		type: 'number',
		typeOptions: { minValue: 1, maxValue: 720 },
		default: 168,
		displayOptions: show(['issueTokens']),
	},
	{
		displayName: 'Token',
		name: 'token',
		type: 'string',
		default: '',
		required: true,
		description: 'The token from the approval link',
		displayOptions: show(['verifyToken']),
	},
	{
		displayName: 'Approved Hash',
		name: 'approvedHash',
		type: 'string',
		default: '',
		required: true,
		description: 'The contentHash the approver saw: the contentHash of a verified approval token, or of a verified seal',
		displayOptions: show(['applyDraft']),
	},
	{
		displayName: 'Activate',
		name: 'activate',
		type: 'boolean',
		default: false,
		description: 'Whether to activate a new or inactive workflow after applying',
		displayOptions: show(['applyDraft']),
	},
];

function parseJsonParam(ctx: IExecuteFunctions, name: string, i: number): unknown {
	const value = ctx.getNodeParameter(name, i, '') as unknown;
	if (value === '' || value === null || value === undefined) return undefined;
	if (typeof value !== 'string') return value;
	try {
		return JSON.parse(value);
	} catch {
		throw new NodeOperationError(ctx.getNode(), `Parameter "${name}" is not valid JSON`, { itemIndex: i });
	}
}

function mcpClientFor(ctx: IExecuteFunctions, endpointUrl: string): McpClient {
	return new McpClient(async (body: unknown, headers: Record<string, string>): Promise<HttpReply> => {
		try {
			const res = (await ctx.helpers.httpRequestWithAuthentication.call(ctx, 'mcpOAuth2Api', {
				method: 'POST',
				url: endpointUrl,
				headers,
				body: JSON.stringify(body),
				json: false,
				encoding: 'text',
				returnFullResponse: true,
			})) as { statusCode?: number; headers?: Record<string, string>; body?: unknown };
			const text = typeof res.body === 'string' ? res.body : res.body === undefined ? '' : JSON.stringify(res.body);
			return { status: res.statusCode ?? 200, headers: res.headers ?? {}, body: text };
		} catch (error) {
			const e = error as { httpCode?: string; message?: string; description?: string };
			return { status: Number(e.httpCode) || 500, headers: {}, body: String(e.description ?? e.message ?? 'request failed') };
		}
	});
}

async function n8nApiFor(ctx: IExecuteFunctions): Promise<N8nApi> {
	const creds = await ctx.getCredentials('n8nApi');
	const base = String(creds.baseUrl ?? '').replace(/\/+$/, '');
	if (!base) throw new NodeOperationError(ctx.getNode(), 'The n8n API credential has no base URL');
	return new N8nApi(async (method, path, body, qs) =>
		ctx.helpers.httpRequestWithAuthentication.call(ctx, 'n8nApi', {
			method,
			url: `${base}${path}`,
			...(body !== undefined ? { body } : {}),
			...(qs ? { qs } : {}),
			json: true,
		}),
	);
}

/** Text of a LangChain chat model answer. */
function answerText(res: unknown): string {
	const content = (res as { content?: unknown })?.content ?? res;
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : String((c as { text?: unknown })?.text ?? ''))).join('');
	return JSON.stringify(content ?? '');
}

function asChange(raw: unknown): EntityChange | null {
	const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	if (!['created', 'changed', 'removed'].includes(String(c.change)) || typeof c.uuid !== 'string') return null;
	const strings = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
	return {
		change: c.change as EntityChange['change'],
		uuid: c.uuid.toLowerCase(),
		name: String(c.name ?? ''),
		entityType: String(c.entityType ?? ''),
		customId: typeof c.customId === 'string' ? c.customId : null,
		previousName: typeof c.previousName === 'string' ? c.previousName : null,
		changedFields: strings(c.changedFields),
		edgesAdded: strings(c.edgesAdded),
		edgesRemoved: strings(c.edgesRemoved),
	};
}

/**
 * Keeps n8n workflows in line with roleALPHA: detects new and changed steps, roles and agents,
 * lets a model propose what that means for the workflows, and applies the proposal only as an
 * approved draft.
 */
export class RoleAlphaWorkflowBuilder implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'roleALPHA Workflow Builder',
		name: 'roleAlphaWorkflowBuilder',
		icon: 'file:roleAlpha.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{ $parameter["operation"] }}',
		description: 'Let a model propose workflow changes when steps, roles or agents change in roleALPHA; apply them only after approval',
		defaults: { name: 'roleALPHA Workflow Builder' },
		inputs: `={{ ((operation) => operation === 'propose' ? ['main', { type: 'ai_languageModel', displayName: 'Model', required: true, maxConnections: 1 }] : ['main'])($parameter.operation) }}`,
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{ name: 'mcpOAuth2Api', required: true, displayOptions: show(MCP_OPS) },
			{ name: 'n8nApi', required: true, displayOptions: show(N8N_OPS) },
			{ name: 'approvalSealApi', required: true, displayOptions: show(TOKEN_OPS) },
		],
		properties,
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const operation = this.getNodeParameter('operation', 0) as string;
		const out: INodeExecutionData[] = [];
		let client: McpClient | undefined;
		let graph: McpGraphSource | undefined;
		const organisationAt = (i: number) => String(this.getNodeParameter('organisation', i) ?? '').trim();
		const getClient = (i: number) => (client ??= mcpClientFor(this, this.getNodeParameter('endpointUrl', i) as string));
		const getGraph = (i: number) => (graph ??= new McpGraphSource(getClient(i), organisationAt(i)));
		const api = N8N_OPS.includes(operation) ? await n8nApiFor(this) : undefined;
		const sealKey = TOKEN_OPS.includes(operation) ? String((await this.getCredentials('approvalSealApi')).key ?? '') : '';

		// The snapshot is one decision over all stored rows.
		if (operation === 'detectChanges') {
			const types = (this.getNodeParameter('entityTypes', 0, []) as string[]).filter(Boolean);
			if (types.length === 0) throw new NodeOperationError(this.getNode(), 'Choose at least one entity type');
			const opts = this.getNodeParameter('detectOptions', 0, {}) as IDataObject;
			const max = typeof opts.maxEntities === 'number' && opts.maxEntities > 0 ? opts.maxEntities : 500;
			const entries: IndexEntry[] = [];
			// A failed index read throws: without the complete index nothing may count as removed.
			for (const type of types) entries.push(...(await listIndex(getClient(0), organisationAt(0), type)));
			if (entries.length > max) {
				throw new NodeOperationError(this.getNode(), `The watched types hold ${entries.length} entities, more than Max Entities (${max}); narrow the types or raise the limit`);
			}
			const read = await readSnapshots(getGraph(0), entries, typeof opts.concurrency === 'number' ? opts.concurrency : 4);
			const res = detectChanges(parseJsonParam(this, 'snapshotRows', 0), read.snapshots, {
				complete: true,
				types,
				unreadable: read.unreadable,
				reportBaseline: opts.reportBaseline === true,
			});
			return [[{ json: { ...res, watched: entries.length } as unknown as IDataObject }]];
		}

		if (operation === 'listWorkflows') {
			const { workflows, credentials } = summarizeWorkflows(await api!.listWorkflows(MANAGED_TAG));
			return [[{ json: { workflows, credentials, count: workflows.length } as unknown as IDataObject }]];
		}

		let managed: ReturnType<typeof summarizeWorkflows> | undefined;
		for (let i = 0; i < items.length; i++) {
			try {
				if (operation === 'propose') {
					const change = asChange(parseJsonParam(this, 'change', i));
					if (!change) throw new NodeOperationError(this.getNode(), 'Change is not a change from Detect Changes', { itemIndex: i });
					managed ??= summarizeWorkflows(await api!.listWorkflows(MANAGED_TAG));
					const nodeTypes = String(this.getNodeParameter('nodeTypes', i, '') ?? '')
						.split(',')
						.map((t) => t.trim())
						.filter(Boolean);
					const extraRules = String(this.getNodeParameter('extraRules', i, '') ?? '')
						.split(/\r?\n/)
						.map((r) => r.trim())
						.filter(Boolean);
					const ctx = { change, entity: await entityContext(getGraph(i), change), workflows: managed.workflows, credentials: managed.credentials, nodeTypes: nodeTypes.length ? nodeTypes : DEFAULT_NODE_TYPES, extraRules };
					const input = buildPlanInput(ctx);
					const model = (await this.getInputConnectionData(NodeConnectionTypes.AiLanguageModel, 0)) as { invoke?: (messages: unknown) => Promise<unknown> } | undefined;
					if (!model || typeof model.invoke !== 'function') throw new NodeOperationError(this.getNode(), 'Attach a chat model to the Model input', { itemIndex: i });
					const attempts = Math.min(5, Math.max(1, Number(this.getNodeParameter('maxAttempts', i, 2)) || 2));
					const targets = new Map<string, N8nWorkflow>();
					const messages: Array<[string, string]> = [
						['system', `${input.systemMessage}\n\nJSON schema of the answer:\n${JSON.stringify(input.schema)}`],
						['human', input.prompt],
					];
					let check: PlanCheck | undefined;
					let n = 0;
					while (n < attempts) {
						n++;
						const text = answerText(await model.invoke(messages));
						// For an update, the loaded target keeps node IDs, credentials and webhooks of nodes that stay.
						const named = (parseAnswer(text) ?? {}) as { targetWorkflowId?: unknown };
						const targetId = typeof named.targetWorkflowId === 'string' ? named.targetWorkflowId.trim() : '';
						let existing: N8nWorkflow | null = null;
						if (targetId && managed.workflows.some((w) => w.id === targetId && !w.isDraft)) {
							if (!targets.has(targetId)) targets.set(targetId, await api!.get(targetId));
							existing = targets.get(targetId) ?? null;
						}
						check = checkPlan(ctx, text, existing);
						if (check.ok) break;
						messages.push(['ai', text], ['human', `Your answer failed the check:\n- ${check.problems.join('\n- ')}\nAnswer again with the complete JSON object.`]);
					}
					out.push({ json: { ...(check as PlanCheck), change, attempts: n } as unknown as IDataObject, pairedItem: { item: i } });
					continue;
				}

				if (operation === 'createDraft') {
					const p = (parseJsonParam(this, 'proposal', i) ?? {}) as PlanCheck & { change?: unknown };
					const change = asChange(p.change);
					if (!change || p.ok !== true || !['create', 'update', 'deactivate'].includes(p.action)) {
						throw new NodeOperationError(this.getNode(), 'Proposal is not a checked proposal with an action (output of Propose with ok = true)', { itemIndex: i });
					}
					const target = p.targetWorkflowId ? await api!.get(p.targetWorkflowId) : null;
					const draft = draftWorkflow(p, change, target);
					const created = await api!.create(draft);
					const draftId = String(created.id ?? '');
					await api!.setTags(draftId, [MANAGED_TAG, DRAFT_TAG]);
					const { hash } = draftHash(draft);
					out.push({
						json: { draftId, draftName: draft.name, action: p.action, targetWorkflowId: p.targetWorkflowId, entityUuid: p.entityUuid, entityName: change.name, change: change.change, reason: p.reason, notes: p.notes ?? [], contentHash: hash },
						pairedItem: { item: i },
					});
					continue;
				}

				if (operation === 'applyDraft') {
					const res = await applyDraft(api!, String(this.getNodeParameter('draftId', i)).trim(), String(this.getNodeParameter('approvedHash', i)).trim(), { activate: this.getNodeParameter('activate', i, false) === true });
					out.push({ json: res as unknown as IDataObject, pairedItem: { item: i } });
					continue;
				}

				if (operation === 'discardDraft') {
					out.push({ json: await discardDraft(api!, String(this.getNodeParameter('draftId', i)).trim()), pairedItem: { item: i } });
					continue;
				}

				if (operation === 'issueTokens') {
					const input = {
						draftId: String(this.getNodeParameter('draftId', i)),
						contentHash: String(this.getNodeParameter('contentHash', i)),
						approver: String(this.getNodeParameter('approver', i)),
					};
					const validHours = this.getNodeParameter('validHours', i, 168) as number;
					const approve = issueToken(sealKey, { ...input, decision: 'approve' }, { validHours });
					const reject = issueToken(sealKey, { ...input, decision: 'reject' }, { validHours });
					out.push({ json: { ...items[i].json, approveToken: approve.token, rejectToken: reject.token, tokenExpiresAt: approve.expiresAt }, pairedItem: { item: i } });
					continue;
				}

				if (operation === 'verifyToken') {
					const check = verifyToken(sealKey, this.getNodeParameter('token', i, ''));
					if (!check.valid || !check.claims) throw new NodeOperationError(this.getNode(), `Approval link not valid: ${check.reason}`, { itemIndex: i });
					const { draftId, contentHash, approver, decision, exp } = check.claims;
					out.push({ json: { draftId, contentHash, approver, decision, expiresAt: new Date(exp * 1000).toISOString() }, pairedItem: { item: i } });
					continue;
				}

				throw new NodeOperationError(this.getNode(), `Unknown operation ${operation}`, { itemIndex: i });
			} catch (error) {
				if (this.continueOnFail()) {
					out.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				if (error instanceof NodeOperationError) throw error;
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}
		return [out];
	}
}
