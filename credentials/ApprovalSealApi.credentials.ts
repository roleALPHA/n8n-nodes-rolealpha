import type { ICredentialType, INodeProperties } from 'n8n-workflow';

/** Key for approval seals. One per circle; never stored in data, notes or chat. */
export class ApprovalSealApi implements ICredentialType {
	name = 'approvalSealApi';

	displayName = 'Approval Seal API';

	properties: INodeProperties[] = [
		{
			displayName: 'Seal Key',
			name: 'key',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'Random secret of at least 32 characters (e.g. 48 hex characters)',
		},
		{
			displayName: 'Legacy Key (v2)',
			name: 'legacyKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description: 'Key of the older v2 seals written by code nodes. Only used to verify, never to sign. Leave empty once no v2 seal is open.',
		},
	];
}
