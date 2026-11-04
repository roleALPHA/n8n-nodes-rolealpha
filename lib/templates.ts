/**
 * Workflows the builder writes itself. Most steps that need a workflow need the same one:
 * a trigger, then the agents responsible for the step, then the runner. The model only picks
 * the template and its few values, so these drafts look the same every time.
 * Agents and step are read at run time; only the custom ID and the runner stay fixed.
 */

const CRON = /^(\S+\s+){4}\S+$/;
const FIELD = /^[\d*,/\-A-Za-z]+$/;

export const TEMPLATES = ['schedule', 'event'] as const;
export type TemplateName = (typeof TEMPLATES)[number];

export interface RunnerInfo {
	id: string;
	name: string;
	/** Inputs the runner declares; null when it takes whatever it gets. */
	inputs: string[] | null;
}

export interface TemplateContext {
	stepName: string;
	customId: string | null;
	runner?: RunnerInfo | null;
	endpointUrl?: string;
	organisation?: string;
	/** The roleALPHA credential of the builder itself. */
	mcpCredential?: { id: string; name: string };
	/** A header credential known from other workflows, for the webhook. */
	webhookCredential?: { id: string; name: string };
}

export interface TemplateResult {
	workflow: { name: string; nodes: unknown[]; connections: unknown } | null;
	problems: string[];
	notes: string[];
}

const DEFAULT_INPUTS = ['agentUuid', 'stepUuid', 'stepCustomId', 'triggerType', 'event', 'organisation'];

export function expandTemplate(name: unknown, values: unknown, t: TemplateContext): TemplateResult {
	const problems: string[] = [];
	const notes: string[] = [];
	const v = (values && typeof values === 'object' ? values : {}) as Record<string, unknown>;
	if (!TEMPLATES.includes(name as TemplateName)) problems.push(`Unknown template "${String(name)}"; use ${TEMPLATES.join(' or ')}`);
	if (!t.customId) problems.push('A template needs a step with a custom ID; give the step one in roleALPHA');
	if (!t.runner) problems.push('A template needs the runner; set Runner Workflow on Propose to an existing workflow');
	const inputs = t.runner?.inputs ?? DEFAULT_INPUTS;
	if (t.runner && !inputs.includes('agentUuid')) problems.push(`Runner "${t.runner.name}" takes no agentUuid`);

	const cron = String(v.cron ?? '').trim();
	if (name === 'schedule' && !(CRON.test(cron) && cron.split(/\s+/).every((f) => FIELD.test(f)))) problems.push('The schedule template needs a cron expression with five fields');
	if (problems.length > 0) return { workflow: null, problems, notes };

	const kind = name as TemplateName;
	const customId = t.customId as string;
	const slug = customId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
	const triggerName = kind === 'schedule' ? 'Schedule' : 'Event';
	const trigger =
		kind === 'schedule'
			? { name: triggerName, type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [0, 0], parameters: { rule: { interval: [{ field: 'cronExpression', expression: cron }] } } }
			: {
					name: triggerName,
					type: 'n8n-nodes-base.webhook',
					typeVersion: 2,
					position: [0, 0],
					parameters: { httpMethod: 'POST', path: `rolealpha-${slug}`, authentication: 'headerAuth', responseMode: 'onReceived', options: {} },
					...(t.webhookCredential ? { credentials: { httpHeaderAuth: t.webhookCredential } } : {}),
				};
	if (kind === 'event') {
		if (!t.webhookCredential) notes.push(`Webhook "${triggerName}": set a Header Auth credential before activating; without it the webhook answers nothing`);
		notes.push(`The sending system has to call POST /webhook/rolealpha-${slug} with that header; set this up there`);
	}
	if (!t.mcpCredential) notes.push('Node "Get step": set the roleALPHA credential before activating');

	const given: Record<string, unknown> = {
		agentUuid: '={{ $json.uuid }}',
		stepUuid: "={{ $('Get step').first().json.step.uuid }}",
		stepCustomId: customId,
		step: customId,
		triggerType: kind,
		trigger: kind,
		event: kind === 'schedule' ? '={{ { reason: "schedule" } }}' : `={{ $('${triggerName}').first().json.body }}`,
		organisation: t.organisation ?? '',
	};
	const value = Object.fromEntries(inputs.map((input) => [input, given[input] ?? '']));
	const schema = inputs.map((input) => ({ id: input, displayName: input, required: false, defaultMatch: false, display: true, type: input === 'event' ? 'any' : 'string', canBeUsedToMatch: true }));

	const nodes = [
		trigger,
		{
			name: 'Get step',
			type: '@rolealpha/n8n-nodes-rolealpha.roleAlpha',
			typeVersion: 1,
			position: [240, 0],
			parameters: { resource: 'responsibility', operation: 'getStep', endpointUrl: t.endpointUrl ?? '', organisation: t.organisation ?? '', step: customId, responsibilityOptions: { resolveHolders: true } },
			...(t.mcpCredential ? { credentials: { mcpOAuth2Api: t.mcpCredential } } : {}),
		},
		{ name: 'Responsible roles', type: 'n8n-nodes-base.splitOut', typeVersion: 1, position: [480, 0], parameters: { fieldToSplitOut: 'step.responsibleRoles', options: {} } },
		{ name: 'Agents', type: 'n8n-nodes-base.splitOut', typeVersion: 1, position: [720, 0], parameters: { fieldToSplitOut: 'holders.agents', options: {} } },
		{
			name: 'Run agent',
			type: 'n8n-nodes-base.executeWorkflow',
			typeVersion: 1.3,
			position: [960, 0],
			parameters: {
				mode: 'each',
				source: 'database',
				workflowId: { __rl: true, mode: 'id', value: t.runner!.id, cachedResultName: t.runner!.name },
				workflowInputs: { mappingMode: 'defineBelow', value, matchingColumns: [], schema, attemptToConvertTypes: false, convertFieldsToString: true },
				options: { waitForSubWorkflow: false },
			},
		},
	];
	const to = (node: string) => ({ main: [[{ node, type: 'main', index: 0 }]] });
	const connections = { [triggerName]: to('Get step'), 'Get step': to('Responsible roles'), 'Responsible roles': to('Agents'), Agents: to('Run agent') };
	return { workflow: { name: `roleALPHA: ${t.stepName || customId} (${customId})`, nodes, connections }, problems, notes };
}
