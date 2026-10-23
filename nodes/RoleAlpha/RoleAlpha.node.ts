import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { McpClient, type HttpReply } from '../../lib/mcp';
import {
	checkApprover,
	findStepByCustomId,
	getAgentRoles,
	getDecider,
	getDuties,
	getRoleHolders,
	getStep,
	McpGraphSource,
	responsibleRolesFor,
	type GraphSource,
} from '../../lib/graph';
import { getAgentContext, listAgents, type ContextView } from '../../lib/agents';
import { keyFor, parseKeyring, type AgentKey } from '../../lib/keys';
import { buildSystemPrompt, type ContextBundle } from '../../lib/prompt';
import { isDue } from '../../lib/schedule';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const show = (resource: string, operation: string[]) => ({ show: { resource: [resource], operation } });

const stepParam = (operations: string[]): INodeProperties => ({
	displayName: 'Step',
	name: 'step',
	type: 'string',
	default: '',
	required: true,
	placeholder: 'UUID or custom ID, e.g. marketing:pr-approval',
	description: 'Process step by UUID or by its custom ID in roleALPHA',
	displayOptions: show('responsibility', operations),
});

const properties: INodeProperties[] = [
	{
		displayName: 'Resource',
		name: 'resource',
		type: 'options',
		noDataExpression: true,
		options: [
			{ name: 'Agent', value: 'agent', description: 'Read an agent\'s context and list the agents of the organisation' },
			{ name: 'Responsibility', value: 'responsibility', description: 'Traverse roles, steps and deciders' },
			{ name: 'Prompt', value: 'prompt', description: 'Build a system prompt from roleALPHA data' },
			{ name: 'Schedule', value: 'schedule', description: 'Decide whether a step is due' },
		],
		default: 'agent',
	},

	// ---------------------------------------------------------------- agent
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['agent'] } },
		options: [
			{ name: 'Get Context', value: 'getContext', action: 'Get the context of an agent', description: 'Identity, roles and guardrails of one agent' },
			{ name: 'Get Context Version', value: 'getContextVersion', action: 'Get the context version of an agent', description: 'Change check; cheap and not audited with agent keys' },
			{ name: 'List Agents', value: 'listAgents', action: 'List agents', description: 'One item per agent of the organisation (MCP) or per key in the credential' },
		],
		default: 'getContext',
	},
	{
		displayName: 'Source',
		name: 'source',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['agent'] } },
		options: [
			{ name: 'MCP (OAuth2)', value: 'mcp', description: 'One connection for all agents of the organisation; new agents run without extra setup' },
			{ name: 'Agent Keys', value: 'agentKey', description: 'One agt_ key per agent, read over the data API' },
		],
		default: 'mcp',
	},
	{
		displayName: 'Agent UUID',
		name: 'agentUuid',
		type: 'string',
		default: '',
		required: true,
		displayOptions: show('agent', ['getContext', 'getContextVersion']),
	},
	{
		displayName: 'Options',
		name: 'agentOptions',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: show('agent', ['getContext', 'listAgents']),
		options: [
			{
				displayName: 'Require Active',
				name: 'requireActive',
				type: 'boolean',
				default: true,
				description: 'Whether to fail (Get Context) or skip (List) agents that are not active in roleALPHA',
			},
			{
				displayName: 'Require Guardrails',
				name: 'requireGuardrails',
				type: 'boolean',
				default: true,
				description: 'Whether to fail when the agent is bound by no policy',
			},
			{
				displayName: 'Include Context',
				name: 'includeContext',
				type: 'boolean',
				default: true,
				description: 'Whether List Agents loads each context (status, roles, guardrails)',
			},
			{
				displayName: 'View',
				name: 'view',
				type: 'options',
				options: [
					{ name: 'Agent', value: 'agent', description: 'Exactly the bundle the agent receives over its own key (needs admin rights on the tenant)' },
					{ name: 'Caller', value: 'caller', description: 'The bundle as visible through the connection\'s own permissions' },
				],
				default: 'agent',
				description: 'MCP only: which view of the context bundle to read',
			},
		],
	},

	// ---------------------------------------------------------------- responsibility
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['responsibility'] } },
		options: [
			{ name: 'Check Approver', value: 'checkApprover', action: 'Check whether a person may decide on a step', description: 'Fail-closed: deciding role first, then the person filling it' },
			{ name: 'Check Responsibility', value: 'checkResponsibility', action: 'Check whether roles are responsible for a step' },
			{ name: 'Find Step by Custom ID', value: 'findStep', action: 'Find a step by custom ID' },
			{ name: 'Get Decider', value: 'getDecider', action: 'Get the deciding role and its holders', description: 'DECIDES_ON, else ACCOUNTABLE_FOR' },
			{ name: 'Get Duties', value: 'getDuties', action: 'Get the steps an agent or roles are responsible for' },
			{ name: 'Get Role Holders', value: 'getRoleHolders', action: 'Get persons and agents filling a role' },
			{ name: 'Get Step', value: 'getStep', action: 'Get a step with neighbours, roles and policies' },
		],
		default: 'getDuties',
	},
	{
		displayName: 'MCP Endpoint URL',
		name: 'endpointUrl',
		type: 'string',
		default: 'https://rolealpha.app/api/mcp',
		required: true,
		displayOptions: { show: { resource: ['agent', 'responsibility'] }, hide: { source: ['agentKey'] } },
	},
	{
		displayName: 'Organisation',
		name: 'organisation',
		type: 'string',
		default: '',
		required: true,
		description: 'Organisation (tenant) name or ID as roleALPHA knows it',
		displayOptions: { show: { resource: ['agent', 'responsibility'] }, hide: { source: ['agentKey'] } },
	},
	{
		displayName: 'Agent UUID',
		name: 'agentUuid',
		type: 'string',
		default: '',
		description: 'Read the roles this agent fulfils. Leave empty to pass role UUIDs instead.',
		displayOptions: show('responsibility', ['getDuties', 'checkResponsibility']),
	},
	{
		displayName: 'Role UUIDs',
		name: 'roleUuids',
		type: 'string',
		default: '',
		description: 'Comma-separated role UUIDs, or an array via expression. Used when no agent UUID is given.',
		displayOptions: show('responsibility', ['getDuties', 'checkResponsibility']),
	},
	{
		displayName: 'Custom ID',
		name: 'customId',
		type: 'string',
		default: '',
		required: true,
		displayOptions: show('responsibility', ['findStep']),
	},
	stepParam(['getStep', 'getDecider', 'checkApprover', 'checkResponsibility']),
	{
		displayName: 'Role UUID',
		name: 'roleUuid',
		type: 'string',
		default: '',
		required: true,
		displayOptions: show('responsibility', ['getRoleHolders']),
	},
	{
		displayName: 'Acting Person',
		name: 'actor',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'name@example.com or Name <name@example.com>',
		description: 'Address of the person who wants to decide, as the channel reports it',
		displayOptions: show('responsibility', ['checkApprover']),
	},
	{
		displayName: 'Options',
		name: 'responsibilityOptions',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: { show: { resource: ['responsibility'] } },
		options: [
			{
				displayName: 'Resolve Holders',
				name: 'resolveHolders',
				type: 'boolean',
				default: true,
				description: 'Whether Get Step also reads the persons and agents filling each role',
			},
			{
				displayName: 'Fail If Not Found',
				name: 'failIfNotFound',
				type: 'boolean',
				default: true,
				description: 'Whether Find Step fails when no step has this custom ID',
			},
			{
				displayName: 'Fail If Denied',
				name: 'failIfDenied',
				type: 'boolean',
				default: false,
				description: 'Whether Check Approver / Check Responsibility fail instead of returning allowed = false',
			},
			{
				displayName: 'One Item per Duty',
				name: 'splitDuties',
				type: 'boolean',
				default: true,
				description: 'Whether Get Duties returns one item per role and step',
			},
		],
	},

	// ---------------------------------------------------------------- prompt
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['prompt'] } },
		options: [{ name: 'Build System Prompt', value: 'buildSystemPrompt', action: 'Build a system prompt' }],
		default: 'buildSystemPrompt',
	},
	{
		displayName: 'Context Bundle',
		name: 'bundle',
		type: 'json',
		default: '={{ $json }}',
		required: true,
		description: 'Output of Agent → Get Context',
		displayOptions: show('prompt', ['buildSystemPrompt']),
	},
	{
		displayName: 'Step',
		name: 'stepJson',
		type: 'json',
		default: '',
		description: 'Output of Responsibility → Get Step (optional)',
		displayOptions: show('prompt', ['buildSystemPrompt']),
	},
	{
		displayName: 'Duties',
		name: 'duties',
		type: 'json',
		default: '',
		description: 'Array of duties from Responsibility → Get Duties (optional)',
		displayOptions: show('prompt', ['buildSystemPrompt']),
	},
	{
		displayName: 'Trigger Type',
		name: 'triggerType',
		type: 'string',
		default: '',
		placeholder: 'schedule, event, chat …',
		displayOptions: show('prompt', ['buildSystemPrompt']),
	},
	{
		displayName: 'Event Data',
		name: 'event',
		type: 'json',
		default: '',
		description: 'Shown to the model as data, never as instructions',
		displayOptions: show('prompt', ['buildSystemPrompt']),
	},
	{
		displayName: 'Additional Rules',
		name: 'extraRules',
		type: 'string',
		typeOptions: { rows: 4 },
		default: '',
		description: 'One technical rule per line, e.g. output format. No roles, persons or duties.',
		displayOptions: show('prompt', ['buildSystemPrompt']),
	},

	// ---------------------------------------------------------------- schedule
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['schedule'] } },
		options: [{ name: 'Is Due', value: 'isDue', action: 'Decide whether a step is due' }],
		default: 'isDue',
	},
	{
		displayName: 'Frequency',
		name: 'frequency',
		type: 'string',
		default: '={{ $json.step?.frequency }}',
		description: 'daily, weekly, biweekly, monthly, quarterly, semiannual, annual; event_driven and on_demand never run on a schedule',
		displayOptions: show('schedule', ['isDue']),
	},
	{
		displayName: 'Due Date',
		name: 'dueDate',
		type: 'string',
		default: '={{ $json.step?.dueDate }}',
		description: 'Optional date (YYYY-MM-DD) from the step; if set, the step runs once on or after it',
		displayOptions: show('schedule', ['isDue']),
	},
	{
		displayName: 'Last Run At',
		name: 'lastRunAt',
		type: 'string',
		default: '',
		description: 'When this agent last ran this step (ISO date). Empty means never.',
		displayOptions: show('schedule', ['isDue']),
	},
	{
		displayName: 'Options',
		name: 'scheduleOptions',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: show('schedule', ['isDue']),
		options: [
			{ displayName: 'Time Zone', name: 'timeZone', type: 'string', default: 'Europe/Berlin' },
			{ displayName: 'Earliest ISO Weekday', name: 'weekday', type: 'number', typeOptions: { minValue: 1, maxValue: 7 }, default: 1, description: 'Weekly and biweekly steps start on or after this day (1 = Monday)' },
			{ displayName: 'Not Before Hour', name: 'notBeforeHour', type: 'number', typeOptions: { minValue: 0, maxValue: 23 }, default: 0 },
			{ displayName: 'Only Due Items', name: 'onlyDue', type: 'boolean', default: false, description: 'Whether to drop items that are not due' },
		],
	},
];

// -------------------------------------------------------------------- helpers

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

function uuidList(value: unknown): string[] {
	const raw = Array.isArray(value) ? value : String(value ?? '').split(',');
	return raw.map((v) => String(v).trim()).filter((v) => UUID.test(v));
}

async function agentRequest(ctx: IExecuteFunctions, baseUrl: string, keyring: AgentKey[], agentUuid: string, path: string): Promise<IDataObject> {
	const uuid = agentUuid.trim().toLowerCase();
	if (!UUID.test(uuid)) throw new NodeOperationError(ctx.getNode(), `Not an agent UUID: "${agentUuid}"`);
	return (await ctx.helpers.httpRequest({
		method: 'GET',
		url: `${baseUrl.replace(/\/+$/, '')}/api/agents/${uuid}${path}`,
		headers: { 'x-agent-key': keyFor(keyring, uuid), Accept: 'application/json' },
		json: true,
	})) as IDataObject;
}

function summarizeBundle(bundle: ContextBundle): IDataObject {
	const roles = (bundle.context ?? []).filter((c) => c.kind === 'role');
	return {
		agentUuid: bundle.agent?.uuid,
		agentName: bundle.agent?.name,
		status: bundle.agent?.status ?? null,
		contextVersion: bundle.contextVersion ?? null,
		roleUuids: roles.map((r) => r.uuid),
		roleNames: roles.map((r) => r.name),
		guardrailCount: (bundle.guardrails ?? []).length,
	};
}

function mcpClientFor(ctx: IExecuteFunctions, endpointUrl: string): McpClient {
	const transport = async (body: unknown, headers: Record<string, string>): Promise<HttpReply> => {
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
	};
	return new McpClient(transport);
}

async function resolveStepUuid(ctx: IExecuteFunctions, graph: GraphSource, value: string, i: number): Promise<string> {
	const v = value.trim();
	if (UUID.test(v)) return v;
	const step = await findStepByCustomId(graph, v);
	if (!step) throw new NodeOperationError(ctx.getNode(), `No step with custom ID "${v}"`, { itemIndex: i });
	return step.uuid;
}

// -------------------------------------------------------------------- node

export class RoleAlpha implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'roleALPHA',
		name: 'roleAlpha',
		icon: 'file:roleAlpha.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{ $parameter["resource"] + ": " + $parameter["operation"] }}',
		description: 'Run agents from roleALPHA: own context, duties, deciders and system prompts',
		defaults: { name: 'roleALPHA' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{ name: 'roleAlphaAgentKeysApi', required: true, displayOptions: { show: { resource: ['agent'], source: ['agentKey'] } } },
			{ name: 'mcpOAuth2Api', required: true, displayOptions: { show: { resource: ['agent', 'responsibility'] }, hide: { source: ['agentKey'] } } },
		],
		properties,
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const out: INodeExecutionData[] = [];
		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;

		const source = resource === 'agent' ? (this.getNodeParameter('source', 0, 'mcp') as string) || 'mcp' : '';
		let keyring: AgentKey[] = [];
		let baseUrl = '';
		if (source === 'agentKey') {
			const creds = await this.getCredentials('roleAlphaAgentKeysApi');
			baseUrl = String(creds.baseUrl ?? '');
			try {
				keyring = parseKeyring(String(creds.keys ?? ''));
			} catch (error) {
				throw new NodeOperationError(this.getNode(), `roleALPHA Agent Keys: ${(error as Error).message}`);
			}
		}

		// One MCP session (and graph cache) per execution keeps traversals consistent and cheap.
		let client: McpClient | undefined;
		let graph: GraphSource | undefined;
		const organisationAt = (i: number) => String(this.getNodeParameter('organisation', i) ?? '').trim();
		const getClient = (i: number) => (client ??= mcpClientFor(this, this.getNodeParameter('endpointUrl', i) as string));
		const getGraph = (i: number) => (graph ??= new McpGraphSource(getClient(i), organisationAt(i)));

		// Reads one context bundle from the chosen source.
		const loadBundle = async (agentUuid: string, i: number, opts: IDataObject): Promise<ContextBundle> => {
			if (source === 'agentKey') return (await agentRequest(this, baseUrl, keyring, agentUuid, '/context')) as unknown as ContextBundle;
			const uuid = agentUuid.trim().toLowerCase();
			if (!UUID.test(uuid)) throw new NodeOperationError(this.getNode(), `Not an agent UUID: "${agentUuid}"`, { itemIndex: i });
			return getAgentContext(getClient(i), organisationAt(i), uuid, ((opts.view as string) || 'agent') as ContextView);
		};

		if (resource === 'agent' && operation === 'listAgents' && source === 'mcp') {
			const opts = this.getNodeParameter('agentOptions', 0, {}) as IDataObject;
			const includeContext = opts.includeContext !== false;
			const requireActive = opts.requireActive !== false;
			for (const entry of await listAgents(getClient(0), organisationAt(0))) {
				// Inactive agents are skipped early; Get Context checks the status again (fail closed).
				if (requireActive && entry.status !== 'active') continue;
				const row: IDataObject = { ...entry };
				if (includeContext) {
					try {
						Object.assign(row, summarizeBundle(await loadBundle(entry.agentUuid, 0, opts)));
					} catch (error) {
						if (!this.continueOnFail()) throw error;
						row.error = (error as Error).message;
					}
					if (requireActive && row.status !== 'active' && !row.error) continue;
				}
				out.push({ json: row });
			}
			return [out];
		}

		if (resource === 'agent' && operation === 'listAgents') {
			const opts = this.getNodeParameter('agentOptions', 0, {}) as IDataObject;
			const includeContext = opts.includeContext !== false;
			const requireActive = opts.requireActive !== false;
			for (const entry of keyring) {
				const row: IDataObject = { agentUuid: entry.agentUuid, label: entry.label };
				if (includeContext) {
					try {
						const bundle = (await agentRequest(this, baseUrl, keyring, entry.agentUuid, '/context')) as unknown as ContextBundle;
						Object.assign(row, summarizeBundle(bundle));
					} catch (error) {
						if (!this.continueOnFail()) throw error;
						row.error = (error as Error).message;
					}
					if (requireActive && row.status !== 'active' && !row.error) continue;
				}
				out.push({ json: row });
			}
			return [out];
		}

		for (let i = 0; i < items.length; i++) {
			try {
				if (resource === 'agent') {
					const agentUuid = this.getNodeParameter('agentUuid', i) as string;
					if (operation === 'getContextVersion') {
						if (source === 'agentKey') {
							const res = await agentRequest(this, baseUrl, keyring, agentUuid, '/context/version');
							out.push({ json: { agentUuid: agentUuid.trim().toLowerCase(), ...res }, pairedItem: { item: i } });
						} else {
							const b = await loadBundle(agentUuid, i, {});
							out.push({ json: { agentUuid: agentUuid.trim().toLowerCase(), contextVersion: b.contextVersion ?? null }, pairedItem: { item: i } });
						}
						continue;
					}
					const opts = this.getNodeParameter('agentOptions', i, {}) as IDataObject;
					const bundle = await loadBundle(agentUuid, i, opts);
					const summary = summarizeBundle(bundle);
					if (opts.requireActive !== false && summary.status !== 'active') {
						throw new NodeOperationError(this.getNode(), `Agent ${summary.agentName ?? agentUuid} is not active in roleALPHA (status: ${summary.status ?? 'unknown'})`, { itemIndex: i });
					}
					if (opts.requireGuardrails !== false && summary.guardrailCount === 0) {
						throw new NodeOperationError(this.getNode(), `Agent ${summary.agentName ?? agentUuid} is bound by no policy; refusing to run without guardrails`, { itemIndex: i });
					}
					out.push({ json: { ...summary, bundle: bundle as unknown as IDataObject }, pairedItem: { item: i } });
					continue;
				}

				if (resource === 'responsibility') {
					const g = getGraph(i);
					const opts = this.getNodeParameter('responsibilityOptions', i, {}) as IDataObject;
					const failIfDenied = opts.failIfDenied === true;

					const roleUuidsFor = async (): Promise<string[]> => {
						const agentUuid = String(this.getNodeParameter('agentUuid', i, '') ?? '').trim();
						if (agentUuid) return (await getAgentRoles(g, agentUuid)).map((r) => r.uuid);
						const roles = uuidList(this.getNodeParameter('roleUuids', i, ''));
						if (roles.length === 0) throw new NodeOperationError(this.getNode(), 'Give an agent UUID or at least one role UUID', { itemIndex: i });
						return roles;
					};

					if (operation === 'findStep') {
						const customId = this.getNodeParameter('customId', i) as string;
						const step = await findStepByCustomId(g, customId);
						if (!step && opts.failIfNotFound !== false) throw new NodeOperationError(this.getNode(), `No step with custom ID "${customId}"`, { itemIndex: i });
						out.push({ json: { found: !!step, customId, step: step as unknown as IDataObject }, pairedItem: { item: i } });
					} else if (operation === 'getStep') {
						const uuid = await resolveStepUuid(this, g, this.getNodeParameter('step', i) as string, i);
						const step = await getStep(g, uuid, { resolveHolders: opts.resolveHolders !== false });
						out.push({ json: { step: step as unknown as IDataObject }, pairedItem: { item: i } });
					} else if (operation === 'getDecider') {
						const uuid = await resolveStepUuid(this, g, this.getNodeParameter('step', i) as string, i);
						out.push({ json: { stepUuid: uuid, ...(await getDecider(g, uuid)) } as unknown as IDataObject, pairedItem: { item: i } });
					} else if (operation === 'checkApprover') {
						const uuid = await resolveStepUuid(this, g, this.getNodeParameter('step', i) as string, i);
						const res = await checkApprover(g, uuid, this.getNodeParameter('actor', i) as string);
						if (!res.allowed && failIfDenied) throw new NodeOperationError(this.getNode(), `Not allowed: ${res.reason}`, { itemIndex: i });
						out.push({ json: { stepUuid: uuid, ...res } as unknown as IDataObject, pairedItem: { item: i } });
					} else if (operation === 'checkResponsibility') {
						const uuid = await resolveStepUuid(this, g, this.getNodeParameter('step', i) as string, i);
						const roles = await responsibleRolesFor(g, uuid, await roleUuidsFor());
						if (roles.length === 0 && failIfDenied) throw new NodeOperationError(this.getNode(), 'None of the roles is responsible for this step', { itemIndex: i });
						out.push({ json: { stepUuid: uuid, responsible: roles.length > 0, roles } as unknown as IDataObject, pairedItem: { item: i } });
					} else if (operation === 'getDuties') {
						const duties = await getDuties(g, await roleUuidsFor());
						if (opts.splitDuties === false) out.push({ json: { duties } as unknown as IDataObject, pairedItem: { item: i } });
						else for (const d of duties) out.push({ json: d as unknown as IDataObject, pairedItem: { item: i } });
					} else if (operation === 'getRoleHolders') {
						const roleUuid = this.getNodeParameter('roleUuid', i) as string;
						out.push({ json: { roleUuid, ...(await getRoleHolders(g, roleUuid)) } as unknown as IDataObject, pairedItem: { item: i } });
					}
					continue;
				}

				if (resource === 'prompt') {
					const raw = parseJsonParam(this, 'bundle', i) as IDataObject | undefined;
					const bundle = (raw && typeof raw.bundle === 'object' ? raw.bundle : raw) as unknown as ContextBundle;
					if (!bundle || !bundle.agent) throw new NodeOperationError(this.getNode(), 'Context Bundle has no agent', { itemIndex: i });
					const stepRaw = parseJsonParam(this, 'stepJson', i) as IDataObject | undefined;
					const step = (stepRaw && typeof stepRaw.step === 'object' ? stepRaw.step : stepRaw) as never;
					const duties = parseJsonParam(this, 'duties', i);
					const rules = String(this.getNodeParameter('extraRules', i, '') ?? '')
						.split(/\r?\n/)
						.map((r) => r.trim())
						.filter(Boolean);
					const systemPrompt = buildSystemPrompt({
						bundle: { ...bundle, guardrails: bundle.guardrails ?? [], context: bundle.context ?? [] },
						step: step ?? null,
						duties: Array.isArray(duties) ? (duties as never) : [],
						trigger: { type: (this.getNodeParameter('triggerType', i, '') as string) || undefined, event: parseJsonParam(this, 'event', i) },
						extraRules: rules,
					});
					out.push({ json: { ...items[i].json, systemPrompt }, pairedItem: { item: i } });
					continue;
				}

				if (resource === 'schedule') {
					const opts = this.getNodeParameter('scheduleOptions', i, {}) as IDataObject;
					const res = isDue(this.getNodeParameter('frequency', i, '') as string, this.getNodeParameter('lastRunAt', i, '') as string, new Date(), {
						timeZone: (opts.timeZone as string) || 'Europe/Berlin',
						dueDate: (this.getNodeParameter('dueDate', i, '') as string) || null,
						weekday: typeof opts.weekday === 'number' ? opts.weekday : null,
						notBeforeHour: typeof opts.notBeforeHour === 'number' ? opts.notBeforeHour : null,
					});
					if (opts.onlyDue === true && !res.due) continue;
					out.push({ json: { ...items[i].json, schedule: res as unknown as IDataObject }, pairedItem: { item: i } });
					continue;
				}

				throw new NodeOperationError(this.getNode(), `Unknown operation ${resource}/${operation}`, { itemIndex: i });
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
