import type { IDataObject, INodeType, INodeTypeDescription, IWebhookFunctions, IWebhookResponseData } from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import { parseEvent, parseSecrets, verifySignature } from '../../lib/webhook';

/**
 * Receives signed roleALPHA context webhooks. Register the production URL in roleALPHA
 * (agent → "Context & Access") and put the signing secret into the credential.
 */
export class RoleAlphaTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'roleALPHA Trigger',
		name: 'roleAlphaTrigger',
		icon: 'file:roleAlpha.svg',
		group: ['trigger'],
		version: 1,
		description: 'Starts when the context of an agent changes in roleALPHA',
		defaults: { name: 'roleALPHA Trigger' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'roleAlphaWebhookApi', required: true }],
		webhooks: [{ name: 'default', httpMethod: 'POST', responseMode: 'onReceived', path: 'rolealpha' }],
		properties: [
			{
				displayName: 'Agent UUIDs',
				name: 'agentFilter',
				type: 'string',
				default: '',
				description: 'Comma-separated agent UUIDs to accept. Empty accepts every agent with a valid signature.',
			},
		],
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const req = this.getRequestObject();
		const res = this.getResponseObject();
		const reject = (status: number, message: string): IWebhookResponseData => {
			res.status(status).json({ ok: false, message });
			return { noWebhookResponse: true };
		};

		const body = this.getBodyData() as IDataObject;
		const event = parseEvent(body);
		if (!event) return reject(400, 'Not a roleALPHA context event');

		const creds = await this.getCredentials('roleAlphaWebhookApi');
		const secrets = parseSecrets(String(creds.secrets ?? ''), event.agentUuid);
		const raw = req.rawBody ?? Buffer.from(JSON.stringify(body));
		if (!verifySignature(secrets, raw, this.getHeaderData()['x-ra-signature'])) return reject(401, 'Invalid signature');

		const filter = String(this.getNodeParameter('agentFilter', '') ?? '')
			.split(',')
			.map((v) => v.trim().toLowerCase())
			.filter(Boolean);
		if (filter.length > 0 && !filter.includes(event.agentUuid.toLowerCase())) {
			res.status(202).json({ ok: true, ignored: true });
			return { noWebhookResponse: true };
		}

		return { workflowData: [this.helpers.returnJsonArray([event as unknown as IDataObject])] };
	}
}
