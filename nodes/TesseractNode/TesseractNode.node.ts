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
		name: 'tesseractNode',
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
				displayName: 'Detect on Entire Image?',
				name: 'detectEntireImage',
				type: 'boolean',
				default: true,
				description: 'Whether to perform OCR on the entire image or on a box',
			},
			{
				displayName: 'Top Y',
				name: 'top',
				type: 'number',
				default: 0,
				typeOptions: {
					minValue: 0
				},
				displayOptions: {
					show: {
						detectEntireImage: [false],
					}
				}
			},
			{
				displayName: 'Left X',
				name: 'left',
				type: 'number',
				default: 0,
				typeOptions: {
					minValue: 0
				},
				displayOptions: {
					show: {
						detectEntireImage: [false],
					}
				}
			},
			{
				displayName: 'Width',
				name: 'width',
				type: 'number',
				default: 100,
				typeOptions: {
					minValue: 0
				},
				displayOptions: {
					show: {
						detectEntireImage: [false],
					}
				}
			},
			{
				displayName: 'Height',
				name: 'height',
				type: 'number',
				default: 100,
				typeOptions: {
					minValue: 0
				},
				displayOptions: {
					show: {
						detectEntireImage: [false],
					}
				}
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
				let newItem: INodeExecutionData;
				const imageFieldName: string = this.getNodeParameter('inputDataFieldName', itemIndex, 'data') as string;
				const entireImage: boolean = this.getNodeParameter('detectEntireImage', itemIndex, true) as boolean;
				let boundingBox;
				if (!entireImage) {
					boundingBox = {
						top: this.getNodeParameter('top', itemIndex, 0) as number,
						left: this.getNodeParameter('left', itemIndex, 0) as number,
						width: this.getNodeParameter('width', itemIndex, 100) as number,
						height: this.getNodeParameter('height', itemIndex, 100) as number,
					}
				}
				switch (operation) {
					case "ocr":
						newItem = await performOCR.bind(this)(worker, items[itemIndex], itemIndex, imageFieldName, boundingBox);
						break;
					case "boxes":
						const granularity = this.getNodeParameter('granularity', itemIndex, 'words') as "paragraphs" | "lines" | "words" | "symbols";
						newItem = await extractBoxes.bind(this)(worker, items[itemIndex], itemIndex, imageFieldName, granularity, boundingBox);
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
