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
import { sharedPacer } from '../../lib/pacer';
import {
	checkApprover,
	findStepByCustomId,
	getAgentRoles,
	getDecider,
	getCircleLeads,
	getDuties,
	getRoleHolders,
	getStep,
	McpGraphSource,
	responsibleRolesFor,
	type GraphSource,
	type Step,
} from '../../lib/graph';
import { getAgentContext, listAgents, type ContextView } from '../../lib/agents';
import { keyFor, parseKeyring, type AgentKey } from '../../lib/keys';
import { buildSystemPrompt, buildTask, type ContextBundle } from '../../lib/prompt';
import { isDue } from '../../lib/schedule';
import { buildShareInput, checkShare, SHARE_SCHEMA, type ShareInput, type ShareResult } from '../../lib/share';
import { checkStart, findStaleWaits, planAfterRun, type FinishedRun, type Limits, type WaitRow } from '../../lib/waits';
import { DEFAULT_SETTINGS, SETTING_BOUNDS, resolveSettings, type SettingRow } from '../../lib/settings';
import { checkWrite, compilePatterns, consolidateMemory, selectMemory, type MemoryFact, type MemoryLimits, type MemoryPolicy, type RememberRequest } from '../../lib/memory';
import {
	buildCurationPrompt,
	checkCuration,
	lintPages,
	locatePages,
	selectKnowledge,
	writeEntry,
	type CircleInfo,
	type KnowledgeLimits,
	type KnowledgeOptions,
	type KnowledgePage,
	type Page,
	type PageWrite,
} from '../../lib/knowledge';
import { AgentRunError, AgentRunTokens, mcpRefusalCode, type FormPost, type FunctionAccount } from '../../lib/agentRun';
import { costOf, priceTableFromRows, type Priced } from '../../lib/pricing';

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
			{ name: 'Memory', value: 'memory', description: 'What the agent\'s roles remember from earlier runs: check a fact, pick facts for the prompt, clean up' },
			{ name: 'Prompt', value: 'prompt', description: 'Build a system prompt from roleALPHA data' },
			{ name: 'Schedule', value: 'schedule', description: 'Decide whether a step is due' },
			{ name: 'Settings', value: 'settings', description: 'Runner limits from defaults and a settings table (global, step, agent)' },
			{ name: 'Share', value: 'share', description: 'The part of a step that belongs to the agent\'s roles, and what it needs from other roles' },
			{ name: 'Tool', value: 'tool', description: 'List and call roleALPHA MCP tools, e.g. as the read tool of an AI agent' },
			{ name: 'Wait', value: 'wait', description: 'Wait for and wake other agents within one step' },
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
			{ name: 'Report Usage', value: 'reportUsage', action: 'Report the usage of a run', description: 'Reports what this run consumed (tokens, model, cost) with the function account, for the agent\'s budget in roleALPHA. The cost comes from your price rows; roleALPHA does not price runs.' },
			{ name: 'Start Run', value: 'startRun', action: 'Start a run as an agent', description: 'Swaps the function account token for a run token of the agent (agent:run). A refusal comes back as data with its code.' },
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
			{ name: 'Get Circle Lead', value: 'getCircleLead', action: 'Get the role leading the circle', description: 'One item per circle of the roles: the leading role and its holders, e.g. to escalate to' },
			{ name: 'Get Decider', value: 'getDecider', action: 'Get the deciding role and its holders', description: 'DECIDES_ON, else ACCOUNTABLE_FOR' },
			{ name: 'Get Duties', value: 'getDuties', action: 'Get the steps an agent or roles are responsible for' },
			{ name: 'Get Role Holders', value: 'getRoleHolders', action: 'Get persons and agents filling a role' },
			{ name: 'Get Step', value: 'getStep', action: 'Get a step with neighbours, roles and policies' },
		],
		default: 'getDuties',
	},
	{
		displayName: 'Connect As',
		name: 'connectAs',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['agent', 'responsibility', 'tool'] }, hide: { source: ['agentKey'], operation: ['startRun', 'reportUsage', 'listAgents'] } },
		options: [
			{ name: 'Function Account', value: 'account', description: 'The view of the connection itself' },
			{ name: 'Agent (Run Token)', value: 'agent', description: 'Exactly the view of the agent of this run (needs agent:run and a function account with client credentials)' },
		],
		default: 'account',
	},
	{
		displayName: 'Run Agent UUID',
		name: 'runAgentUuid',
		type: 'string',
		default: '',
		required: true,
		description: 'The agent this run acts as',
		displayOptions: { show: { resource: ['agent', 'responsibility', 'tool'], connectAs: ['agent'] }, hide: { source: ['agentKey'], operation: ['startRun', 'reportUsage', 'listAgents'] } },
	},
	{
		displayName: 'Run Agent UUID',
		name: 'runAgentUuid',
		type: 'string',
		default: '',
		required: true,
		description: 'The agent this run acts as',
		displayOptions: show('agent', ['startRun', 'reportUsage']),
	},
	{
		displayName: 'Run ID',
		name: 'runId',
		type: 'string',
		default: '={{ $execution.id }}',
		description: 'Names the run in every audit entry; 1-128 characters of A-Z a-z 0-9 . _ : -. Sub-workflows of the run pass the same ID.',
		displayOptions: { show: { resource: ['agent', 'responsibility', 'tool'], connectAs: ['agent'] }, hide: { source: ['agentKey'], operation: ['startRun', 'reportUsage', 'listAgents'] } },
	},
	{
		displayName: 'Run ID',
		name: 'runId',
		type: 'string',
		default: '={{ $execution.id }}',
		description: 'Names the run in every audit entry; 1-128 characters of A-Z a-z 0-9 . _ : -. Sub-workflows of the run pass the same ID.',
		displayOptions: show('agent', ['startRun', 'reportUsage']),
	},
	{
		displayName: 'Model',
		name: 'usageModel',
		type: 'string',
		default: '',
		description: 'The model the run used, e.g. from the chat model node. Looked up in the price rows.',
		displayOptions: show('agent', ['reportUsage']),
	},
	{
		displayName: 'Input Tokens',
		name: 'usageInputTokens',
		type: 'string',
		default: '',
		description: 'Uncached input tokens of the whole run',
		displayOptions: show('agent', ['reportUsage']),
	},
	{
		displayName: 'Output Tokens',
		name: 'usageOutputTokens',
		type: 'string',
		default: '',
		description: 'Output tokens of the whole run',
		displayOptions: show('agent', ['reportUsage']),
	},
	{
		displayName: 'Cache Read Tokens',
		name: 'usageCacheReadTokens',
		type: 'string',
		default: '',
		displayOptions: show('agent', ['reportUsage']),
	},
	{
		displayName: 'Cache Write Tokens',
		name: 'usageCacheWriteTokens',
		type: 'string',
		default: '',
		displayOptions: show('agent', ['reportUsage']),
	},
	{
		displayName: 'Price Rows',
		name: 'priceRows',
		type: 'json',
		default: '',
		placeholder: '[{"model":"claude-opus-5-5","input":4,"cacheRead":0.4,"cacheWrite":5,"output":20,"currency":"USD","asOf":"2026-11-20"}]',
		description: 'Your prices per million tokens, one row per model (e.g. all rows of a data table). With your own AI key only you know them; roleALPHA does not price runs. Without a matching row the run is reported with tokens only and counts as "without a price".',
		displayOptions: show('agent', ['reportUsage']),
	},
	{
		displayName: 'Cost',
		name: 'usageCost',
		type: 'string',
		default: '',
		description: 'Optional: the cost of the run if the workflow already knows it. Overrides the price rows.',
		displayOptions: show('agent', ['reportUsage']),
	},
	{
		displayName: 'Currency',
		name: 'usageCurrency',
		type: 'string',
		default: 'USD',
		description: 'ISO code of Cost, e.g. USD',
		displayOptions: show('agent', ['reportUsage']),
	},
	{
		displayName: 'MCP Endpoint URL',
		name: 'endpointUrl',
		type: 'string',
		default: 'https://rolealpha.app/api/mcp',
		required: true,
		displayOptions: { show: { resource: ['agent', 'responsibility', 'tool'] }, hide: { source: ['agentKey'] } },
	},
	{
		displayName: 'Organisation',
		name: 'organisation',
		type: 'string',
		default: '',
		required: true,
		description: 'Organisation (tenant) name or ID as roleALPHA knows it',
		displayOptions: { show: { resource: ['agent', 'responsibility', 'tool'] }, hide: { source: ['agentKey'] } },
	},
	{
		displayName: 'Agent UUID',
		name: 'agentUuid',
		type: 'string',
		default: '',
		description: 'Read the roles this agent fulfils. Leave empty to pass role UUIDs instead.',
		displayOptions: show('responsibility', ['getDuties', 'checkResponsibility', 'getCircleLead']),
	},
	{
		displayName: 'Role UUIDs',
		name: 'roleUuids',
		type: 'string',
		default: '',
		description: 'Comma-separated role UUIDs, or an array via expression. Used when no agent UUID is given.',
		displayOptions: show('responsibility', ['getDuties', 'checkResponsibility', 'getCircleLead']),
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
				displayName: 'Role Details',
				name: 'roleDetails',
				type: 'boolean',
				default: false,
				description: 'Whether Get Step also reads purpose, accountabilities and domains of each responsible role (needed for Share → Build Input)',
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
		displayOptions: { show: { resource: ['prompt', 'share'], operation: ['buildSystemPrompt', 'buildInput'] } },
	},
	{
		displayName: 'Step',
		name: 'stepJson',
		type: 'json',
		default: '',
		description: 'Output of Responsibility → Get Step (optional for the prompt, required for Share)',
		displayOptions: { show: { resource: ['prompt', 'share'], operation: ['buildSystemPrompt', 'buildInput'] } },
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
		displayOptions: { show: { resource: ['prompt', 'share'], operation: ['buildSystemPrompt', 'buildInput'] } },
	},
	{
		displayName: 'Event Data',
		name: 'event',
		type: 'json',
		default: '',
		description: 'Shown to the model as data, never as instructions',
		displayOptions: { show: { resource: ['prompt', 'share'], operation: ['buildSystemPrompt', 'buildInput'] } },
	},
	{
		displayName: 'Share',
		name: 'share',
		type: 'json',
		default: '',
		description: 'Output of Share → Check (optional). Adds the agent\'s part, the rules for waiting within the step and a task text.',
		displayOptions: show('prompt', ['buildSystemPrompt']),
	},
	{
		displayName: 'Memory',
		name: 'memory',
		type: 'json',
		default: '',
		description: 'Output of Memory → Select (optional). Set it, even empty, when the agent has the remember tool: it adds the rules for remembering and what the roles remember.',
		displayOptions: show('prompt', ['buildSystemPrompt']),
	},
	{
		displayName: 'Knowledge',
		name: 'knowledge',
		type: 'json',
		default: '',
		description: 'Output of Memory → Select Pages (optional). Set it, even empty, when knowledge pages are on: it adds what the pages of the roles and circles hold and the rules that keep knowledge apart from policies.',
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

	// ---------------------------------------------------------------- share
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['share'] } },
		options: [
			{ name: 'Build Input', value: 'buildInput', action: 'Build the input for the share decision', description: 'System message, prompt and ids for a model call; the step needs Role Details' },
			{ name: 'Check', value: 'check', action: 'Check the share decision', description: 'Keeps only real accountabilities and real other roles of the step' },
		],
		default: 'buildInput',
	},
	{
		displayName: 'Responsible Roles',
		name: 'roles',
		type: 'json',
		default: '',
		description: 'The agent\'s roles that are responsible for the step: output of Responsibility → Check Responsibility, an array of roles or of UUIDs. Empty: every role of the bundle on the step.',
		displayOptions: show('share', ['buildInput']),
	},
	{
		displayName: 'Share Input',
		name: 'shareInput',
		type: 'json',
		default: '',
		required: true,
		description: 'Output of Share → Build Input',
		displayOptions: show('share', ['check']),
	},
	{
		displayName: 'Model Answer',
		name: 'answer',
		type: 'json',
		default: '={{ $json.output }}',
		required: true,
		description: 'The structured answer of the model (duties, notMine, reason)',
		displayOptions: show('share', ['check']),
	},

	// ---------------------------------------------------------------- wait
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['wait'] } },
		options: [
			{ name: 'Plan After Run', value: 'planAfterRun', action: 'Plan what follows a run', description: 'Whether the agent waited, which row to add, whom to wake and which rows to remove' },
			{ name: 'Check Start', value: 'checkStart', action: 'Check whether a run may start', description: 'Duplicate-run guard: after adding this run\'s lease, the oldest live lease wins; a later start is queued' },
			{ name: 'Find Stale Waits', value: 'findStale', action: 'Find waits nobody answered', description: 'For a scheduler: unanswered waits, orphaned queued starts, dead leases, expired rows and waits to escalate' },
		],
		default: 'planAfterRun',
	},
	{
		displayName: 'Rows',
		name: 'rows',
		type: 'json',
		default: '={{ $input.all().map(item => item.json) }}',
		description: 'Stored wait rows (state, step_uuid, agent_uuid, roles, waits_for, record_keys, event, run_id, attempts, progress, at)',
		displayOptions: { show: { resource: ['wait'] } },
	},
	{
		displayName: 'Finished Run',
		name: 'run',
		type: 'json',
		default: '',
		required: true,
		placeholder: '{"runId":"","stepUuid":"","agentUuid":"","roleUuids":[],"recordKeys":[],"startedAt":"","event":{},"attempt":0}',
		description: 'The run that just ended (Plan After Run) or wants to start (Check Start)',
		displayOptions: show('wait', ['planAfterRun', 'checkStart']),
	},
	{
		displayName: 'Settings Rows',
		name: 'settingRows',
		type: 'json',
		default: '',
		description: 'Optional rows of the settings table (scope, target, key, value). Limits per agent and step from these rows win over the options below.',
		displayOptions: { show: { resource: ['wait'] } },
	},
	{
		displayName: 'Options',
		name: 'waitOptions',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: { show: { resource: ['wait'] } },
		options: [
			{ displayName: 'Max Attempts', name: 'maxAttempts', type: 'number', typeOptions: { minValue: 1 }, default: 5, description: 'How often one agent is woken for the same step and records' },
			{ displayName: 'Keep Done Rows (Hours)', name: 'keepDoneHours', type: 'number', typeOptions: { minValue: 1 }, default: 168 },
			{ displayName: 'Older Than (Minutes)', name: 'olderThanMinutes', type: 'number', typeOptions: { minValue: 1 }, default: 60, description: 'Find Stale Waits: only waits at least this old' },
			{ displayName: 'Run Timeout (Minutes)', name: 'runTimeoutMinutes', type: 'number', typeOptions: { minValue: 1 }, default: 15, description: 'Leases older than this count as dead' },
		],
	},

	// ---------------------------------------------------------------- memory
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['memory'] } },
		options: [
			{ name: 'Check Write', value: 'checkWrite', action: 'Check a fact to remember', description: 'Checks a remember call of the agent and returns the row to add, or the reason it is not kept' },
			{ name: 'Select', value: 'select', action: 'Pick what the roles remember', description: 'The facts of the roles the agent fills now, for this step and these records, within the limits' },
			{ name: 'Consolidate', value: 'consolidate', action: 'Clean up the memory', description: 'For a scheduler: rows to delete (expired, replaced, forgotten, over the limit per role)' },
			{ name: 'Locate Pages', value: 'locatePages', action: 'Locate the knowledge pages', description: 'Paths of the pages of the roles the agent fills and of their circles, to read from your store' },
			{ name: 'Select Pages', value: 'selectPages', action: 'Pick the knowledge for the prompt', description: 'What the pages of the agent\'s roles and circles hold, within the size limit; proposals for roleALPHA stay out' },
			{ name: 'Write Page', value: 'writePage', action: 'Add a fact to its page', description: 'The new content of the page for a fact Check Write sent to a page; your store writes it if the page still has the base version' },
			{ name: 'Build Curation Prompt', value: 'curationPrompt', action: 'Build the prompt to curate a page', description: 'Sort new entries in, merge, link, drop what is outdated or contradicts a policy' },
			{ name: 'Check Curation', value: 'checkCuration', action: 'Check a curated page', description: 'Frontmatter kept, nothing about persons or secrets added, no rules, within the deletion limit' },
			{ name: 'Lint Pages', value: 'lintPages', action: 'Find pages to curate or repair', description: 'For a scheduler: pages due for curation, of roles that are gone, without UUID, with broken links' },
		],
		default: 'checkWrite',
	},
	{
		displayName: 'Rows',
		name: 'rows',
		type: 'json',
		default: '={{ $input.all().map(item => item.json) }}',
		description: 'Stored memory rows (role_uuid, step_uuid, record_keys, topic, fact, agent_uuid, run_id, at, expires_at)',
		displayOptions: show('memory', ['select', 'consolidate']),
	},
	{
		displayName: 'Context Bundle',
		name: 'bundle',
		type: 'json',
		default: '',
		required: true,
		description: 'Output of Agent → Get Context of this run. Only the roles the agent fills there count.',
		displayOptions: show('memory', ['checkWrite', 'select', 'locatePages', 'selectPages', 'curationPrompt']),
	},
	{
		displayName: 'Pages',
		name: 'pages',
		type: 'json',
		default: '={{ $input.all().map(item => item.json) }}',
		description: 'Pages read from your store, each with path, content (Markdown) and version (a Git SHA, a counter, …)',
		displayOptions: show('memory', ['selectPages', 'lintPages']),
	},
	{
		displayName: 'Circles',
		name: 'circles',
		type: 'json',
		default: '',
		description: 'Output of Responsibility → Get Circle Lead for the agent (all items), e.g. {{ $(\'Get Circle Lead\').all().map(i => i.json) }}. Circles the bundle reaches count as well.',
		displayOptions: show('memory', ['checkWrite', 'locatePages', 'selectPages', 'curationPrompt']),
	},
	{
		displayName: 'Knowledge Pages',
		name: 'knowledgePages',
		type: 'boolean',
		default: false,
		description: 'Whether lasting facts of a role (scope role) and of a circle (scope circle) go to its page instead of a row. Notes on a step or records stay rows.',
		displayOptions: show('memory', ['checkWrite']),
	},
	{
		displayName: 'Write',
		name: 'write',
		type: 'json',
		default: '',
		required: true,
		description: 'Output of Memory → Check Write with target "page"',
		displayOptions: show('memory', ['writePage']),
	},
	{
		displayName: 'Page',
		name: 'page',
		type: 'json',
		default: '',
		description: 'The page as read from your store: path, content, version. Empty when it does not exist yet.',
		displayOptions: show('memory', ['writePage', 'curationPrompt', 'checkCuration']),
	},
	{
		displayName: 'Answer',
		name: 'answer',
		type: 'string',
		typeOptions: { rows: 6 },
		default: '',
		required: true,
		description: 'What the model answered to Build Curation Prompt: the whole page in a markdown block',
		displayOptions: show('memory', ['checkCuration']),
	},
	{
		displayName: 'Existing Pages',
		name: 'existingPages',
		type: 'json',
		default: '',
		description: 'Optional: all pages of the store as path and name, so a curation may only link to pages that exist',
		displayOptions: show('memory', ['curationPrompt', 'checkCuration']),
	},
	{
		displayName: 'Step',
		name: 'stepJson',
		type: 'json',
		default: '',
		description: 'Output of Responsibility → Get Step (optional). With holders, their names are not kept.',
		displayOptions: show('memory', ['checkWrite', 'select']),
	},
	{
		displayName: 'Record Keys',
		name: 'recordKeys',
		type: 'string',
		default: '',
		description: 'Keys of the records this run works on, comma-separated (optional)',
		displayOptions: show('memory', ['checkWrite', 'select']),
	},
	{
		displayName: 'Run ID',
		name: 'memoryRunId',
		type: 'string',
		default: '',
		displayOptions: show('memory', ['checkWrite']),
	},
	{
		displayName: 'Remember Call',
		name: 'request',
		type: 'json',
		default: '',
		required: true,
		placeholder: '{"fact":"","role":"","scope":"role","topic":""}',
		description: 'What the model passed to the remember tool: fact, role (optional), scope (role, step, records), topic (optional), forget (optional)',
		displayOptions: show('memory', ['checkWrite']),
	},
	{
		displayName: 'Known Role UUIDs',
		name: 'knownRoles',
		type: 'string',
		default: '',
		description: 'Optional: the roles (and, for pages, circles) that still exist (comma-separated or an array). Facts of other roles are removed; their pages are reported as orphaned.',
		displayOptions: show('memory', ['consolidate', 'lintPages']),
	},
	{
		displayName: 'Settings Rows',
		name: 'settingRows',
		type: 'json',
		default: '',
		description: 'Optional rows of the settings table: maxMemoryFacts, maxMemoryChars, memoryTtlDays, keepMemoryFacts, and for pages maxKnowledgeChars, maxPageChars, maxNewEntries, knowledgeCurateDays, maxCurationDeletePct, knowledgeLinkDepth (global < step < agent)',
		displayOptions: { show: { resource: ['memory'] } },
	},
	{
		displayName: 'What Is Never Kept',
		name: 'memoryPolicy',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		description: 'Your company decides. Secrets are always refused.',
		displayOptions: show('memory', ['checkWrite', 'checkCuration']),
		options: [
			{ displayName: 'Block E-Mail Addresses', name: 'blockEmails', type: 'boolean', default: true },
			{ displayName: 'Block UUIDs', name: 'blockUuids', type: 'boolean', default: true },
			{ displayName: 'Block Phone Numbers', name: 'blockPhoneNumbers', type: 'boolean', default: true },
			{ displayName: 'Block Names of Role Holders', name: 'blockPersonNames', type: 'boolean', default: true, description: 'Whether names of the persons who fill the roles of the step are refused (needs Step with holders)' },
			{ displayName: 'Blocked Terms', name: 'blockedTerms', type: 'string', typeOptions: { rows: 4 }, default: '', description: 'One term per line (or comma-separated), matched as a whole word in any case, e.g. customer names read from your CRM with an expression' },
			{ displayName: 'Blocked Patterns', name: 'blockedPatterns', type: 'string', typeOptions: { rows: 3 }, default: '', description: 'One regular expression per line, e.g. for an IBAN' },
		],
	},
	{
		displayName: 'Knowledge Options',
		name: 'knowledgeOptions',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		description: 'Use the same values in every node of your knowledge workflows',
		displayOptions: show('memory', ['checkWrite', 'locatePages', 'selectPages', 'writePage', 'curationPrompt', 'checkCuration']),
		options: [
			{ displayName: 'Path Template', name: 'pathTemplate', type: 'string', default: '{entity}s/{uuid}.md', description: 'Where the page of a role or circle lives. Placeholders: {entity} (role, circle), {uuid}, {slug}. The UUID keeps a page when the role is renamed.' },
			{ displayName: 'Language', name: 'language', type: 'options', options: [{ name: 'German', value: 'de' }, { name: 'English', value: 'en' }], default: 'de', description: 'Headings and type names of new pages; pages in either language are read' },
			{ displayName: 'Normative Terms', name: 'normativeTerms', type: 'string', typeOptions: { rows: 3 }, default: '', description: 'Words that make a statement a rule (one per line or comma-separated). Empty: muss, darf nicht, verboten, must, must not, shall, not allowed, … A fact with one of them goes to the proposals for roleALPHA, not into the prompt.' },
			{ displayName: 'Allow Rules in Curation', name: 'allowNormativeCuration', type: 'boolean', default: false, description: 'Whether a curation may add normative statements outside the proposals' },
			{ displayName: 'Curating Role', name: 'curatingRole', type: 'string', default: '', description: 'Role (UUID or name) whose holders curate circle pages. Empty: any role of the circle.' },
		],
	},

	// ---------------------------------------------------------------- settings
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['settings'] } },
		options: [{ name: 'Resolve', value: 'resolve', action: 'Resolve runner settings', description: `Defaults < global < step < agent; every value clamped to fixed bounds (${Object.entries(SETTING_BOUNDS).map(([k, b]) => `${k} ${b.min}–${b.max}`).join(', ')})` }],
		default: 'resolve',
	},
	{
		displayName: 'Settings Rows',
		name: 'settingRows',
		type: 'json',
		default: '',
		description: 'Rows of the settings table: scope (global, step, agent), target (step UUID or custom ID, agent UUID), key, value. Empty: defaults only.',
		displayOptions: show('settings', ['resolve']),
	},
	{
		displayName: 'Agent UUID',
		name: 'settingsAgent',
		type: 'string',
		default: '',
		displayOptions: show('settings', ['resolve']),
	},
	{
		displayName: 'Step',
		name: 'settingsStep',
		type: 'string',
		default: '',
		description: 'Step UUID',
		displayOptions: show('settings', ['resolve']),
	},
	{
		displayName: 'Step Custom ID',
		name: 'settingsStepCustomId',
		type: 'string',
		default: '',
		displayOptions: show('settings', ['resolve']),
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

	// ---------------------------------------------------------------- tool
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['tool'] } },
		options: [
			{ name: 'Call Tool', value: 'callTool', action: 'Call an MCP tool', description: 'Calls one allowed tool; tool name "list" returns the allowed tools with their arguments. Errors come back as data, so a model can react.' },
			{ name: 'List Tools', value: 'listTools', action: 'List the allowed MCP tools' },
		],
		default: 'callTool',
	},
	{
		displayName: 'Allowed Tools',
		name: 'allowedTools',
		type: 'string',
		default: 'get_entity_details,get_entity_relationships,search_entities,search_persons,find_responsible',
		required: true,
		description: 'Comma-separated tool names. Any other tool is refused, even if the token could call it.',
		displayOptions: { show: { resource: ['tool'] } },
	},
	{
		displayName: 'Tool Name',
		name: 'toolName',
		type: 'string',
		default: '',
		description: 'One of the allowed tools, or "list"',
		displayOptions: show('tool', ['callTool']),
	},
	{
		displayName: 'Tool Arguments',
		name: 'toolArguments',
		type: 'string',
		default: '{}',
		description: 'Arguments as JSON text. The organisation is added when missing.',
		displayOptions: show('tool', ['callTool']),
	},
];

// -------------------------------------------------------------------- helpers

function bundleParam(ctx: IExecuteFunctions, i: number): ContextBundle {
	const raw = parseJsonParam(ctx, 'bundle', i) as IDataObject | undefined;
	const bundle = (raw && typeof raw.bundle === 'object' ? raw.bundle : raw) as unknown as ContextBundle;
	if (!bundle || !bundle.agent) throw new NodeOperationError(ctx.getNode(), 'Context Bundle has no agent', { itemIndex: i });
	return { ...bundle, guardrails: bundle.guardrails ?? [], context: bundle.context ?? [] };
}

function stepParamJson(ctx: IExecuteFunctions, i: number): Step | null {
	const raw = parseJsonParam(ctx, 'stepJson', i) as IDataObject | undefined;
	const step = (raw && typeof raw.step === 'object' ? raw.step : raw) as Step | undefined;
	return step && typeof step === 'object' && step.uuid ? step : null;
}

function knowledgeLimits(rows: SettingRow[], agentUuid: string): KnowledgeLimits {
	const s = resolveSettings(rows, { agentUuid }).settings;
	return {
		maxChars: s.maxKnowledgeChars,
		maxPageChars: s.maxPageChars,
		maxNewEntries: s.maxNewEntries,
		curateAfterDays: s.knowledgeCurateDays,
		maxDeletePct: s.maxCurationDeletePct,
		linkDepth: s.knowledgeLinkDepth,
	};
}

function knowledgeOptions(ctx: IExecuteFunctions, i: number): KnowledgeOptions {
	const o = ctx.getNodeParameter('knowledgeOptions', i, {}) as IDataObject;
	const terms = String(o.normativeTerms ?? '')
		.split(/\r?\n|,/)
		.map((t) => t.trim())
		.filter(Boolean);
	return {
		pathTemplate: String(o.pathTemplate ?? '').trim() || undefined,
		language: o.language === 'en' ? 'en' : 'de',
		normativeTerms: terms.length ? terms : undefined,
		allowNormativeCuration: o.allowNormativeCuration === true,
		curatingRole: String(o.curatingRole ?? '').trim() || undefined,
	};
}

function listParam<T>(ctx: IExecuteFunctions, name: string, i: number): T[] {
	const raw = parseJsonParam(ctx, name, i) as unknown;
	if (Array.isArray(raw)) return raw as T[];
	if (raw && typeof raw === 'object') return [raw as T];
	return [];
}

function pageParam(ctx: IExecuteFunctions, i: number): Page | null {
	const raw = parseJsonParam(ctx, 'page', i) as IDataObject | undefined;
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	if (typeof raw.content !== 'string') return null;
	return { path: String(raw.path ?? ''), content: raw.content, version: (raw.version as string | number | null | undefined) ?? null };
}

function memoryPolicyParam(ctx: IExecuteFunctions, i: number): MemoryPolicy {
	const opts = ctx.getNodeParameter('memoryPolicy', i, {}) as IDataObject;
	const lines = (v: unknown, split: RegExp) => String(v ?? '').split(split).map((t) => t.trim()).filter(Boolean);
	const policy: MemoryPolicy = {
		blockEmails: opts.blockEmails !== false,
		blockUuids: opts.blockUuids !== false,
		blockPhoneNumbers: opts.blockPhoneNumbers !== false,
		blockPersonNames: opts.blockPersonNames !== false,
		blockedTerms: lines(opts.blockedTerms, /\r?\n|,/),
		blockedPatterns: lines(opts.blockedPatterns, /\r?\n/),
	};
	try {
		compilePatterns(policy.blockedPatterns);
	} catch (error) {
		throw new NodeOperationError(ctx.getNode(), (error as Error).message, { itemIndex: i });
	}
	return policy;
}

function memoryLimits(rows: SettingRow[], bundle: ContextBundle, step: Step | null): MemoryLimits {
	const s = resolveSettings(rows, { agentUuid: bundle.agent?.uuid ?? '', stepUuid: step?.uuid ?? '', stepCustomId: step?.customId ?? '' }).settings;
	return { maxFacts: s.maxMemoryFacts, maxChars: s.maxMemoryChars, ttlDays: s.memoryTtlDays, keepFacts: s.keepMemoryFacts };
}

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

interface RunAuth {
	tokens: AgentRunTokens;
	account: FunctionAccount;
	agentUuid: string;
	runId: string;
}

const formPost = (ctx: IExecuteFunctions): FormPost => async (url, form, headers) => {
	const res = (await ctx.helpers.httpRequest({
		method: 'POST',
		url,
		headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', ...headers },
		body: new URLSearchParams(form).toString(),
		json: false,
		encoding: 'text',
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	})) as { statusCode?: number; body?: unknown };
	return { status: res.statusCode ?? 0, body: typeof res.body === 'string' ? res.body : JSON.stringify(res.body ?? '') };
};

/** The function account behind the MCP credential; a run token needs client credentials. */
async function functionAccount(ctx: IExecuteFunctions): Promise<FunctionAccount> {
	const c = await ctx.getCredentials('mcpOAuth2Api');
	if (c.grantType !== 'clientCredentials' || !c.accessTokenUrl || !c.clientId || !c.clientSecret) {
		throw new NodeOperationError(ctx.getNode(), 'Acting as an agent needs a function account: an MCP OAuth2 credential with grant type Client Credentials');
	}
	return { tokenUrl: String(c.accessTokenUrl), clientId: String(c.clientId), clientSecret: String(c.clientSecret), authentication: c.authentication === 'body' ? 'body' : 'header' };
}

function refusedRun(ctx: IExecuteFunctions, e: AgentRunError, i?: number): NodeOperationError {
	return new NodeOperationError(ctx.getNode(), `roleALPHA refused the run: ${e.code}`, { itemIndex: i, description: `${e.description} (reaction: ${e.reaction})` });
}

/** MCP under a run token: one swap per run, swapped again on 401; a refusal ends the run. */
function agentTransport(ctx: IExecuteFunctions, endpointUrl: string, auth: RunAuth) {
	return async (body: unknown, headers: Record<string, string>): Promise<HttpReply> => {
		const send = async (token: string) =>
			(await ctx.helpers.httpRequest({
				method: 'POST',
				url: endpointUrl,
				headers: { ...headers, Authorization: `Bearer ${token}` },
				body: JSON.stringify(body),
				json: false,
				encoding: 'text',
				returnFullResponse: true,
				ignoreHttpStatusErrors: true,
			})) as { statusCode?: number; headers?: Record<string, string>; body?: unknown };
		let res = await send((await auth.tokens.runToken(auth.account, auth.agentUuid, auth.runId)).token);
		if (res.statusCode === 401) {
			auth.tokens.forget(auth.account, auth.agentUuid, auth.runId);
			res = await send((await auth.tokens.runToken(auth.account, auth.agentUuid, auth.runId, { fresh: true })).token);
		}
		const text = typeof res.body === 'string' ? res.body : res.body === undefined ? '' : JSON.stringify(res.body);
		if (res.statusCode === 401 || res.statusCode === 403) throw new AgentRunError(mcpRefusalCode(text) || `http_${res.statusCode}`, res.statusCode, text.slice(0, 300));
		return { status: res.statusCode ?? 200, headers: res.headers ?? {}, body: text };
	};
}

function mcpClientFor(ctx: IExecuteFunctions, endpointUrl: string, auth?: RunAuth): McpClient {
	if (auth) return new McpClient(agentTransport(ctx, endpointUrl, auth));
	// All workflows with this credential share one roleALPHA budget: wait for a slot instead of meeting 429.
	const credentialId = (ctx.getNode().credentials?.mcpOAuth2Api as { id?: string } | undefined)?.id ?? '';
	const pacer = sharedPacer(`${endpointUrl}|${credentialId}`);
	const transport = async (body: unknown, headers: Record<string, string>): Promise<HttpReply> => {
		if (pacer) await pacer.acquire();
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
			{ name: 'mcpOAuth2Api', required: true, displayOptions: { show: { resource: ['agent', 'responsibility', 'tool'] }, hide: { source: ['agentKey'] } } },
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

		// Reporting a run's usage: with the function account, never the run token (agentRun.ts).
		if (resource === 'agent' && operation === 'reportUsage') {
			if (source === 'agentKey') throw new NodeOperationError(this.getNode(), 'Report Usage needs a function account (source MCP), not agent keys');
			const tokens = new AgentRunTokens(formPost(this));
			const account = await functionAccount(this);
			for (let i = 0; i < items.length; i++) {
				const count = (name: string): number | undefined => {
					const v = String(this.getNodeParameter(name, i, '') ?? '').trim();
					if (v === '') return undefined;
					const n = Number(v.replace(',', '.'));
					if (!Number.isFinite(n) || n < 0) throw new NodeOperationError(this.getNode(), `"${name}" is not a number ≥ 0`, { itemIndex: i });
					return n;
				};
				const agentUuid = String(this.getNodeParameter('runAgentUuid', i, '') ?? '').trim().toLowerCase();
				const runId = String(this.getNodeParameter('runId', i, '') ?? '').trim();
				const model = String(this.getNodeParameter('usageModel', i, '') ?? '').trim() || undefined;
				const usage = {
					inputTokens: count('usageInputTokens'),
					cacheReadTokens: count('usageCacheReadTokens'),
					cacheWriteTokens: count('usageCacheWriteTokens'),
					outputTokens: count('usageOutputTokens'),
				};
				const cost = count('usageCost');
				let priced: Priced | { cost: number; currency: string; priceKind: 'tabelle'; priceSource: string } | null = null;
				if (cost !== undefined) {
					priced = { cost, currency: String(this.getNodeParameter('usageCurrency', i, 'USD') ?? 'USD').trim().toUpperCase(), priceKind: 'tabelle', priceSource: 'workflow' };
				} else {
					const rows = parseJsonParam(this, 'priceRows', i);
					if (Array.isArray(rows) && rows.length > 0) {
						try {
							priced = costOf(usage, model, priceTableFromRows(rows as Array<Record<string, unknown>>));
						} catch (error) {
							throw new NodeOperationError(this.getNode(), (error as Error).message, { itemIndex: i });
						}
					}
				}
				try {
					const receipt = await tokens.reportUsage(account, { agentUuid, runId, model, ...usage, ...(priced ?? {}) }, tokens.usageUrlFor(account, agentUuid, runId));
					out.push({ json: { ...items[i].json, usage: { reported: true, ...receipt, cost: priced?.cost ?? null, currency: priced?.currency ?? null } } as unknown as IDataObject, pairedItem: { item: i } });
				} catch (error) {
					if (!(error instanceof AgentRunError)) throw error;
					// A refusal comes back as data: reporting must never break the run it reports.
					out.push({ json: { ...items[i].json, usage: { reported: false, code: error.code, reaction: error.reaction, reason: error.description } } as unknown as IDataObject, pairedItem: { item: i } });
				}
			}
			return [out];
		}

		// Acting as an agent: every MCP call of this node runs under the run token of that agent.
		const startRun = resource === 'agent' && operation === 'startRun';
		const usesMcp = ['agent', 'responsibility', 'tool'].includes(resource) && source !== 'agentKey';
		const asAgent = startRun || (usesMcp && operation !== 'listAgents' && this.getNodeParameter('connectAs', 0, 'account') === 'agent');
		let runAuth: RunAuth | undefined;
		if (asAgent) {
			runAuth = {
				tokens: new AgentRunTokens(formPost(this)),
				account: await functionAccount(this),
				agentUuid: String(this.getNodeParameter('runAgentUuid', 0, '') ?? '').trim().toLowerCase(),
				runId: String(this.getNodeParameter('runId', 0, '') ?? '').trim(),
			};
		}

		if (startRun) {
			const auth = runAuth!;
			try {
				const t = await auth.tokens.runToken(auth.account, auth.agentUuid, auth.runId);
				// The token itself never leaves the node.
				out.push({ json: { started: true, agentUuid: t.agent.uuid, agentName: t.agent.name, runId: t.runId, expiresAt: new Date(t.expiresAt).toISOString() } });
			} catch (error) {
				if (!(error instanceof AgentRunError)) throw error;
				out.push({ json: { started: false, agentUuid: auth.agentUuid, runId: auth.runId, code: error.code, reaction: error.reaction, reason: error.description } });
			}
			return [out];
		}

		// One MCP session (and graph cache) per execution keeps traversals consistent and cheap.
		let client: McpClient | undefined;
		let graph: GraphSource | undefined;
		const organisationAt = (i: number) => String(this.getNodeParameter('organisation', i) ?? '').trim();
		const getClient = (i: number) => (client ??= mcpClientFor(this, this.getNodeParameter('endpointUrl', i) as string, runAuth));
		const getGraph = (i: number) => (graph ??= new McpGraphSource(getClient(i), organisationAt(i)));

		// Reads one context bundle from the chosen source.
		const loadBundle = async (agentUuid: string, i: number, opts: IDataObject): Promise<ContextBundle> => {
			if (source === 'agentKey') return (await agentRequest(this, baseUrl, keyring, agentUuid, '/context')) as unknown as ContextBundle;
			const uuid = agentUuid.trim().toLowerCase();
			if (!UUID.test(uuid)) throw new NodeOperationError(this.getNode(), `Not an agent UUID: "${agentUuid}"`, { itemIndex: i });
			// Under a run token the caller is the agent, so its own view needs no admin switch.
			return getAgentContext(getClient(i), organisationAt(i), uuid, (asAgent ? 'caller' : (opts.view as string) || 'agent') as ContextView);
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

		// Wait decisions look at all stored rows at once and return one plan.
		if (resource === 'wait') {
			const rowsRaw = parseJsonParam(this, 'rows', 0);
			const rows = (Array.isArray(rowsRaw) ? rowsRaw : []).filter((r) => r && typeof r === 'object' && (r as IDataObject).state) as WaitRow[];
			const opts = this.getNodeParameter('waitOptions', 0, {}) as IDataObject;
			const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
			const settingRowsRaw = parseJsonParam(this, 'settingRows', 0);
			const settingRows = (Array.isArray(settingRowsRaw) ? settingRowsRaw : []) as SettingRow[];
			// The options are the workflow's defaults; table rows (global < step < agent) win. Both are clamped to the same bounds.
			const optionRows: SettingRow[] = Object.entries({ maxAttempts: opts.maxAttempts, keepDoneHours: opts.keepDoneHours, maxWaitMinutes: opts.olderThanMinutes, runTimeoutMinutes: opts.runTimeoutMinutes })
				.filter(([, v]) => num(v) !== undefined)
				.map(([key, value]) => ({ scope: 'global', key, value }));
			const limitsFor = (t: { agentUuid: string; stepUuid: string; stepCustomId: string }): Limits => {
				const r = resolveSettings([...optionRows, ...settingRows], t).settings;
				return { maxAttempts: r.maxAttempts, keepDoneHours: r.keepDoneHours, maxWaitMinutes: r.maxWaitMinutes, runTimeoutMinutes: r.runTimeoutMinutes };
			};
			const waitOpts = { ...limitsFor({ agentUuid: '', stepUuid: '', stepCustomId: '' }), limitsFor };
			if (operation === 'findStale') {
				const res = findStaleWaits(rows, waitOpts);
				return [[{ json: res as unknown as IDataObject }]];
			}
			const run = parseJsonParam(this, 'run', 0) as FinishedRun | undefined;
			if (operation === 'checkStart') {
				if (!run || !run.runId || !run.stepUuid || !run.agentUuid) {
					throw new NodeOperationError(this.getNode(), 'Run needs runId, stepUuid and agentUuid');
				}
				return [[{ json: checkStart(rows, run, waitOpts) as unknown as IDataObject }]];
			}
			if (!run || !run.runId || !run.stepUuid || !run.agentUuid || !run.startedAt) {
				throw new NodeOperationError(this.getNode(), 'Finished Run needs runId, stepUuid, agentUuid and startedAt');
			}
			const plan = planAfterRun(rows, run, waitOpts);
			return [[{ json: plan as unknown as IDataObject }]];
		}

		// Pages: Locate, Select and Lint look at all pages (or none) at once.
		if (resource === 'memory' && ['locatePages', 'selectPages', 'lintPages'].includes(operation)) {
			const settingRowsRaw = parseJsonParam(this, 'settingRows', 0);
			const settingRows = (Array.isArray(settingRowsRaw) ? settingRowsRaw : []) as SettingRow[];
			if (operation === 'lintPages') {
				const knownRaw = this.getNodeParameter('knownRoles', 0, '') as unknown;
				const known = (Array.isArray(knownRaw) ? knownRaw : String(knownRaw ?? '').split(',')).map((v) => String(v).trim()).filter(Boolean);
				const res = lintPages(parseJsonParam(this, 'pages', 0), { knownUuids: known, limits: knowledgeLimits(settingRows, '') });
				return [[{ json: res as unknown as IDataObject }]];
			}
			const bundle = bundleParam(this, 0);
			const circles = listParam<CircleInfo>(this, 'circles', 0);
			const opts = knowledgeOptions(this, 0);
			let refs;
			try {
				refs = locatePages(bundle, circles, opts);
			} catch (error) {
				throw new NodeOperationError(this.getNode(), (error as Error).message);
			}
			if (operation === 'locatePages') return [refs.map((r) => ({ json: r as unknown as IDataObject }))];
			const res = selectKnowledge(parseJsonParam(this, 'pages', 0), { bundle, circles, opts, limits: knowledgeLimits(settingRows, bundle.agent?.uuid ?? '') });
			return [[{ json: res as unknown as IDataObject }]];
		}

		// Memory: Select and Consolidate look at all stored rows at once.
		if (resource === 'memory' && (operation === 'select' || operation === 'consolidate')) {
			const rows = parseJsonParam(this, 'rows', 0);
			const settingRowsRaw = parseJsonParam(this, 'settingRows', 0);
			const settingRows = (Array.isArray(settingRowsRaw) ? settingRowsRaw : []) as SettingRow[];
			if (operation === 'consolidate') {
				const s = resolveSettings(settingRows).settings;
				const knownRaw = this.getNodeParameter('knownRoles', 0, '') as unknown;
				const known = (Array.isArray(knownRaw) ? knownRaw : String(knownRaw ?? '').split(',')).map((v) => String(v).trim()).filter(Boolean);
				const res = consolidateMemory(rows, { limits: { ttlDays: s.memoryTtlDays, keepFacts: s.keepMemoryFacts }, knownRoleUuids: known });
				return [[{ json: res as unknown as IDataObject }]];
			}
			const bundle = bundleParam(this, 0);
			const step = stepParamJson(this, 0);
			const limits = memoryLimits(settingRows, bundle, step);
			const res = selectMemory(rows, { bundle, stepUuid: step?.uuid ?? null, recordKeys: this.getNodeParameter('recordKeys', 0, ''), limits });
			return [[{ json: res as unknown as IDataObject }]];
		}

		for (let i = 0; i < items.length; i++) {
			try {
				if (resource === 'memory' && operation !== 'checkWrite') {
					const settingRowsRaw = parseJsonParam(this, 'settingRows', i);
					const settingRows = (Array.isArray(settingRowsRaw) ? settingRowsRaw : []) as SettingRow[];
					const opts = knowledgeOptions(this, i);
					const page = pageParam(this, i);
					let res: unknown;
					if (operation === 'writePage') {
						const write = parseJsonParam(this, 'write', i) as PageWrite;
						res = writeEntry(write, page, opts, knowledgeLimits(settingRows, String(write?.entry?.agent ?? '')));
					} else if (operation === 'curationPrompt') {
						if (!page) throw new NodeOperationError(this.getNode(), 'Page is empty: there is nothing to curate', { itemIndex: i });
						const bundle = bundleParam(this, i);
						res = buildCurationPrompt({
							page,
							bundle,
							circles: listParam<CircleInfo>(this, 'circles', i),
							existing: listParam<{ path: string; name?: string }>(this, 'existingPages', i),
							opts,
							limits: knowledgeLimits(settingRows, bundle.agent?.uuid ?? ''),
						});
					} else {
						if (!page) throw new NodeOperationError(this.getNode(), 'Page is empty: give the page that was curated', { itemIndex: i });
						const existing = listParam<{ path: string }>(this, 'existingPages', i).map((p) => String(p?.path ?? '')).filter(Boolean);
						res = checkCuration(page, String(this.getNodeParameter('answer', i, '') ?? ''), {
							policy: memoryPolicyParam(this, i),
							opts,
							limits: knowledgeLimits(settingRows, ''),
							existingPaths: existing,
						});
					}
					// A refusal is data, so the workflow can retry, report or leave the page as it is.
					out.push({ json: res as IDataObject, pairedItem: { item: i } });
					continue;
				}

				if (resource === 'memory') {
					const bundle = bundleParam(this, i);
					const step = stepParamJson(this, i);
					const settingRowsRaw = parseJsonParam(this, 'settingRows', i);
					const limits = memoryLimits((Array.isArray(settingRowsRaw) ? settingRowsRaw : []) as SettingRow[], bundle, step);
					const raw = parseJsonParam(this, 'request', i) as unknown;
					const request = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as RememberRequest;
					const policy = memoryPolicyParam(this, i);
					const knowledgeOn = this.getNodeParameter('knowledgePages', i, false) === true;
					const res = checkWrite(request, {
						bundle,
						step,
						recordKeys: this.getNodeParameter('recordKeys', i, ''),
						runId: String(this.getNodeParameter('memoryRunId', i, '') ?? ''),
						ttlDays: limits.ttlDays,
						policy,
						knowledge: knowledgeOn ? { enabled: true, circles: listParam<CircleInfo>(this, 'circles', i), opts: knowledgeOptions(this, i) } : null,
					});
					// A refusal is data, so the model can shorten or rephrase the fact.
					out.push({ json: res as unknown as IDataObject, pairedItem: { item: i } });
					continue;
				}

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
						const step = await getStep(g, uuid, { resolveHolders: opts.resolveHolders !== false, roleDetails: opts.roleDetails === true });
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
					} else if (operation === 'getCircleLead') {
						for (const lead of await getCircleLeads(g, await roleUuidsFor())) out.push({ json: lead as unknown as IDataObject, pairedItem: { item: i } });
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
					const step = (stepRaw && typeof stepRaw.step === 'object' ? stepRaw.step : stepRaw) as Step | undefined;
					const duties = parseJsonParam(this, 'duties', i);
					const shareRaw = parseJsonParam(this, 'share', i) as IDataObject | undefined;
					const share = (shareRaw && Array.isArray(shareRaw.duties) ? shareRaw : null) as unknown as ShareResult | null;
					const memoryRaw = parseJsonParam(this, 'memory', i) as unknown;
					const memory = Array.isArray(memoryRaw)
						? (memoryRaw as MemoryFact[])
						: memoryRaw && typeof memoryRaw === 'object' && Array.isArray((memoryRaw as IDataObject).memory)
							? ((memoryRaw as IDataObject).memory as unknown as MemoryFact[])
							: null;
					const knowledgeRaw = parseJsonParam(this, 'knowledge', i) as unknown;
					const knowledge = Array.isArray(knowledgeRaw)
						? (knowledgeRaw as KnowledgePage[])
						: knowledgeRaw && typeof knowledgeRaw === 'object' && Array.isArray((knowledgeRaw as IDataObject).knowledge)
							? ((knowledgeRaw as IDataObject).knowledge as unknown as KnowledgePage[])
							: null;
					const rules = String(this.getNodeParameter('extraRules', i, '') ?? '')
						.split(/\r?\n/)
						.map((r) => r.trim())
						.filter(Boolean);
					const systemPrompt = buildSystemPrompt({
						bundle: { ...bundle, guardrails: bundle.guardrails ?? [], context: bundle.context ?? [] },
						step: (step as never) ?? null,
						duties: Array.isArray(duties) ? (duties as never) : [],
						trigger: { type: (this.getNodeParameter('triggerType', i, '') as string) || undefined, event: parseJsonParam(this, 'event', i) },
						extraRules: rules,
						share,
						memory,
						knowledge,
					});
					const json: IDataObject = { ...items[i].json, systemPrompt };
					if (share && step) json.task = buildTask({ step, share, triggerType: (this.getNodeParameter('triggerType', i, '') as string) || undefined });
					out.push({ json, pairedItem: { item: i } });
					continue;
				}

				if (resource === 'share') {
					if (operation === 'buildInput') {
						const raw = parseJsonParam(this, 'bundle', i) as IDataObject | undefined;
						const bundle = (raw && typeof raw.bundle === 'object' ? raw.bundle : raw) as unknown as ContextBundle;
						if (!bundle || !bundle.agent) throw new NodeOperationError(this.getNode(), 'Context Bundle has no agent', { itemIndex: i });
						const stepRaw = parseJsonParam(this, 'stepJson', i) as IDataObject | undefined;
						const step = (stepRaw && typeof stepRaw.step === 'object' ? stepRaw.step : stepRaw) as Step | undefined;
						if (!step || !Array.isArray(step.responsibleRoles)) throw new NodeOperationError(this.getNode(), 'Step is missing or has no responsible roles', { itemIndex: i });
						if (step.responsibleRoles.some((r) => r.accountabilities === undefined)) {
							throw new NodeOperationError(this.getNode(), 'The step has no role details; turn on Role Details in Get Step', { itemIndex: i });
						}
						const rolesRaw = parseJsonParam(this, 'roles', i) as unknown;
						const rolesList = Array.isArray(rolesRaw)
							? rolesRaw
							: rolesRaw && typeof rolesRaw === 'object' && Array.isArray((rolesRaw as IDataObject).roles)
								? ((rolesRaw as IDataObject).roles as unknown[])
								: [];
						const roleUuids = rolesList.map((r) => (r && typeof r === 'object' ? String((r as IDataObject).uuid ?? '') : String(r))).filter(Boolean);
						const input = buildShareInput({ ...bundle, guardrails: bundle.guardrails ?? [], context: bundle.context ?? [] }, step, roleUuids, {
							type: (this.getNodeParameter('triggerType', i, '') as string) || undefined,
							event: parseJsonParam(this, 'event', i),
						});
						out.push({ json: { ...input, schema: SHARE_SCHEMA } as unknown as IDataObject, pairedItem: { item: i } });
					} else {
						const input = parseJsonParam(this, 'shareInput', i) as ShareInput | undefined;
						if (!input || !Array.isArray(input.accountabilities) || !Array.isArray(input.others)) {
							throw new NodeOperationError(this.getNode(), 'Share Input is not the output of Share → Build Input', { itemIndex: i });
						}
						let answer = parseJsonParam(this, 'answer', i) as unknown;
						if (answer && typeof answer === 'object' && (answer as IDataObject).output && typeof (answer as IDataObject).output === 'object') answer = (answer as IDataObject).output;
						out.push({ json: checkShare(input, answer) as unknown as IDataObject, pairedItem: { item: i } });
					}
					continue;
				}

				if (resource === 'tool') {
					const allowed = String(this.getNodeParameter('allowedTools', i, '') ?? '')
						.split(',')
						.map((t) => t.trim())
						.filter(Boolean);
					const name = operation === 'listTools' ? 'list' : String(this.getNodeParameter('toolName', i, '') ?? '').trim();
					try {
						if (name === '' || name === 'list') {
							const tools = (await getClient(i).listTools()).filter((t) => allowed.includes(t.name));
							out.push({ json: { ok: true, tools: tools.map((t) => ({ name: t.name, description: t.description ?? '', arguments: (t.inputSchema ?? {}) as IDataObject })) } as unknown as IDataObject, pairedItem: { item: i } });
						} else if (!allowed.includes(name)) {
							out.push({ json: { ok: false, error: `Tool "${name}" is not allowed. Allowed: ${allowed.join(', ')}` }, pairedItem: { item: i } });
						} else {
							const raw = this.getNodeParameter('toolArguments', i, '{}') as unknown;
							let args: Record<string, unknown>;
							try {
								args = (typeof raw === 'string' ? (raw.trim() ? JSON.parse(raw) : {}) : raw ?? {}) as Record<string, unknown>;
							} catch {
								out.push({ json: { ok: false, error: 'Tool Arguments are not valid JSON' }, pairedItem: { item: i } });
								continue;
							}
							if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
							if (args.organisation === undefined) args.organisation = organisationAt(i);
							out.push({ json: { ok: true, tool: name, result: (await getClient(i).callTool(name, args)) as IDataObject }, pairedItem: { item: i } });
						}
					} catch (error) {
						// A refused run ends the run; any other error goes back to the caller as data.
						if (error instanceof AgentRunError) throw refusedRun(this, error, i);
						out.push({ json: { ok: false, tool: name, error: (error as Error).message.slice(0, 1000) }, pairedItem: { item: i } });
					}
					continue;
				}

				if (resource === 'settings') {
					const raw = parseJsonParam(this, 'settingRows', i);
					const res = resolveSettings((Array.isArray(raw) ? raw : []) as SettingRow[], {
						agentUuid: String(this.getNodeParameter('settingsAgent', i, '') ?? ''),
						stepUuid: String(this.getNodeParameter('settingsStep', i, '') ?? ''),
						stepCustomId: String(this.getNodeParameter('settingsStepCustomId', i, '') ?? ''),
					});
					out.push({ json: { ...items[i].json, settings: res.settings, settingSources: res.sources, settingProblems: res.problems, settingDefaults: DEFAULT_SETTINGS } as unknown as IDataObject, pairedItem: { item: i } });
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
				if (error instanceof AgentRunError) throw refusedRun(this, error, i);
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}
		return [out];
	}
}
