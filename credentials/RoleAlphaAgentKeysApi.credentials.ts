import type { ICredentialType, INodeProperties } from 'n8n-workflow';

/**
 * One credential for every agent this n8n runs: a JSON map agentUuid → agent key.
 * Keys are issued in roleALPHA (agent → "Context & Access") and shown only once.
 */
export class RoleAlphaAgentKeysApi implements ICredentialType {
	name = 'roleAlphaAgentKeysApi';

	displayName = 'roleALPHA Agent Keys API';

	documentationUrl = 'https://doc.rolealpha.app/entity-type-agent/';

	properties: INodeProperties[] = [
		{
			displayName: 'Data Node URL',
			name: 'baseUrl',
			type: 'string',
			default: '',
			placeholder: 'https://<data-node>.rolealpha.app',
			required: true,
			description: 'Base URL of the roleALPHA data node that serves /api/agents/{uuid}/context',
		},
		{
			displayName: 'Agent Keys',
			name: 'keys',
			type: 'string',
			typeOptions: { password: true, rows: 8 },
			default: '',
			required: true,
			placeholder: '{"<agent uuid>": "agt_…"}',
			description:
				'JSON map of agent UUID to agent key, or a list of {"agentUuid", "key", "label"}. Adding an entry is all it takes for a new agent to run.',
		},
	];
}
