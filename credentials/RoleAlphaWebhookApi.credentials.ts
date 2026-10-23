import type { ICredentialType, INodeProperties } from 'n8n-workflow';

/** Signing secrets of roleALPHA context webhooks, shown once when a webhook is registered. */
export class RoleAlphaWebhookApi implements ICredentialType {
	name = 'roleAlphaWebhookApi';

	displayName = 'roleALPHA Webhook API';

	documentationUrl = 'https://doc.rolealpha.app/entity-type-agent/';

	properties: INodeProperties[] = [
		{
			displayName: 'Signing Secrets',
			name: 'secrets',
			type: 'string',
			typeOptions: { password: true, rows: 6 },
			default: '',
			required: true,
			placeholder: '{"<agent uuid>": "<signing secret>"}',
			description: 'One secret, a JSON list of secrets, or a JSON map of agent UUID to secret',
		},
	];
}
