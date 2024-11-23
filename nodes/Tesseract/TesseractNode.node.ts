import {
	type IExecuteFunctions,
	type INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	NodeOperationError
} from 'n8n-workflow';
import {extractBoxes, performOCR} from "./operations";
import {createWorker} from "tesseract.js";

export class TesseractNode implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Tesseract',
		name: 'tesseract',
		subtitle: '={{ $parameter["operation"] }}',
		icon: 'file:tesseract.svg',
		group: ['transform'],
		version: 1,
		description: 'Recognize text in images',
		defaults: {
			name: 'Tesseract',
		},
		inputs: ['main'],
		outputs: ['main'],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				required: true,
				options: [
					{
						name: 'Extract Text',
						value: 'ocr',
						description: 'Extract plain text from an image',
						action: 'Extract plain text from an image',
					},
					{
						name: 'Extract Boxes',
						value: 'boxes',
						description: 'Extract boxes of text from an image',
						action: 'Extract boxes of text from an image',
					},
				],
				default: 'ocr',
			},
			{
				displayName: 'Granularity',
				name: 'granularity',
				type: 'options',
				options: [
					{name: "Paragraphs", value: "paragraphs"},
					{name: "Lines", value: "lines"},
					{name: "Words", value: "words"},
					{name: "Characters", value: "symbols"},
				],
				displayOptions: {
					show: {
						operation: ['boxes'],
					},
				},
				default: 'words',
				description: 'How detailed should the bounding boxes be?',
			},
			{
				displayName: 'Input Image Field Name',
				name: 'inputDataFieldName',
				type: 'string',
				displayOptions: {
					show: {
						operation: ['ocr', 'boxes'],
					},
				},
				default: 'data',
				description: 'The name of the incoming field containing the image to be processed',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add option',
				default: {},
				options: [
					{
						displayName: 'Language',
						name: 'language',
						type: 'string',
						default: 'eng',
						description: 'Choose from the lang codes in https://tesseract-ocr.github.io/tessdoc/Data-Files#data-files-for-version-400-november-29-2016',
						noDataExpression: true
					}
				]
			}
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const operation = this.getNodeParameter('operation', 0, 'ocr') as 'ocr' | 'boxes';
		const lang = this.getNodeParameter('options.language', 0, 'eng') as string;
		const worker = await createWorker(lang);

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				let newItem: INodeExecutionData, imageFieldName: string;
				switch (operation) {
					case "ocr":
						imageFieldName = this.getNodeParameter('inputDataFieldName', itemIndex, 'data') as string;
						newItem = await performOCR.bind(this)(worker, items[itemIndex], itemIndex, imageFieldName);
						break;
					case "boxes":
						imageFieldName = this.getNodeParameter('inputDataFieldName', itemIndex, 'data') as string;
						const granularity = this.getNodeParameter('granularity', itemIndex, 'words') as "paragraphs" | "lines" | "words" | "symbols";
						newItem = await extractBoxes.bind(this)(worker, items[itemIndex], itemIndex, imageFieldName, granularity);
						break;
				}

				items[itemIndex] = newItem;
			} catch (error) {
				if (this.continueOnFail()) {
					items[itemIndex] = {json: this.getInputData(itemIndex)[0].json, error, pairedItem: itemIndex};
				} else {
					if (error.context) {
						error.context.itemIndex = itemIndex;
						throw error;
					}
					throw new NodeOperationError(this.getNode(), error, {
						itemIndex,
					});
				}
			}
		}

		return [items];
	}
}

