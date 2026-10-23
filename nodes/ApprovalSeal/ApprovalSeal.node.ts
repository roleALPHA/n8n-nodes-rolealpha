import type { IDataObject, IExecuteFunctions, INodeExecutionData, INodeType, INodeTypeDescription } from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { signSeal, verifySeal } from '../../lib/seal';

/**
 * Seals the exact version a person approved and checks it again before anything is sent.
 * The key lives only in the credential; the seal can be stored next to the record.
 */
export class ApprovalSeal implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Approval Seal',
		name: 'approvalSeal',
		icon: 'file:approvalSeal.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{ $parameter["operation"] }}',
		description: 'Seal an approved version and verify it before sending',
		defaults: { name: 'Approval Seal' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'approvalSealApi', required: true }],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Sign', value: 'sign', action: 'Seal an approved version' },
					{ name: 'Verify', value: 'verify', action: 'Verify a seal against the current version' },
				],
				default: 'verify',
			},
			{
				displayName: 'Record Type',
				name: 'type',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'post, press_release …',
				description: 'Kind of record; a seal for one type never matches another',
			},
			{
				displayName: 'Sealed Fields',
				name: 'fields',
				type: 'json',
				default: '{}',
				required: true,
				description: 'Exactly the content that was approved (object or array). Any change breaks the seal.',
			},
			{
				displayName: 'Approver',
				name: 'approver',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'name@example.com',
				description: 'Address of the person who approved, as checked against the deciding role',
			},
			{
				displayName: 'Seal',
				name: 'seal',
				type: 'string',
				default: '',
				displayOptions: { show: { operation: ['verify'] } },
				description: 'Stored seal (v3:… or legacy v2:…)',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Output Field',
						name: 'outputField',
						type: 'string',
						default: 'approvalSeal',
						description: 'Name of the field that receives the seal or the check result',
					},
					{
						displayName: 'Fail If Invalid',
						name: 'failIfInvalid',
						type: 'boolean',
						default: true,
						description: 'Whether Verify stops the workflow when the seal does not match',
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const creds = await this.getCredentials('approvalSealApi');
		const keys = { key: String(creds.key ?? ''), legacyKey: String(creds.legacyKey ?? '') || undefined };
		const out: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const operation = this.getNodeParameter('operation', i) as string;
				const type = this.getNodeParameter('type', i) as string;
				const rawFields = this.getNodeParameter('fields', i) as unknown;
				let fields: unknown = rawFields;
				if (typeof rawFields === 'string') {
					try {
						fields = JSON.parse(rawFields);
					} catch {
						throw new NodeOperationError(this.getNode(), 'Sealed Fields is not valid JSON', { itemIndex: i });
					}
				}
				const approver = this.getNodeParameter('approver', i) as string;
				const opts = this.getNodeParameter('options', i, {}) as IDataObject;
				const field = (opts.outputField as string) || 'approvalSeal';

				if (operation === 'sign') {
					const seal = signSeal(keys.key, type, fields, approver);
					out.push({ json: { ...items[i].json, [field]: seal }, pairedItem: { item: i } });
					continue;
				}

				const check = verifySeal(keys, this.getNodeParameter('seal', i, '') as string, type, fields, approver);
				if (!check.valid && opts.failIfInvalid !== false) {
					throw new NodeOperationError(this.getNode(), `Approval seal invalid: ${check.reason}`, { itemIndex: i });
				}
				out.push({ json: { ...items[i].json, [field]: check as unknown as IDataObject }, pairedItem: { item: i } });
			} catch (error) {
				if (this.continueOnFail()) {
					out.push({ json: { ...items[i].json, error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				if (error instanceof NodeOperationError) throw error;
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}
		return [out];
	}
}
