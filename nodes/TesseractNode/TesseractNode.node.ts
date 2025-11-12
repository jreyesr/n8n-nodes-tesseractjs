import {
	type IExecuteFunctions,
	type INodeExecutionData,
	INodeType,
	INodeTypeDescription, JsonObject,
	NodeConnectionType,
	NodeOperationError
} from 'n8n-workflow';
import {extractBoxes, OCROptions, performOCR} from "./operations";
import {createWorker, PSM} from "tesseract.js";

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
		// eslint-disable-next-line n8n-nodes-base/node-class-description-inputs-wrong-regular-node
		inputs: [NodeConnectionType.Main],
		// eslint-disable-next-line n8n-nodes-base/node-class-description-outputs-wrong
		outputs: [NodeConnectionType.Main],
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
				// eslint-disable-next-line n8n-nodes-base/node-param-collection-type-unsorted-items
				options: [
					{
						displayName: 'Language',
						name: 'language',
						type: 'string',
						default: 'eng',
						description: 'Choose from the lang codes in https://tesseract-ocr.github.io/tessdoc/Data-Files#data-files-for-version-400-november-29-2016',
						noDataExpression: true
					},
					{
						displayName: 'Page Segmentation Mode',
						name: 'psm',
						type: 'options',
						default: 'SINGLE_BLOCK',
						description: 'For a description of the modes, see <a href="https://pyimagesearch.com/2021/11/15/tesseract-page-segmentation-modes-psms-explained-how-to-improve-your-ocr-accuracy/">this link</a>',
						options: [
							{
								name: 'Single Block',
								value: 'SINGLE_BLOCK',
								description: 'Assume a single uniform block of text, such as a book page',
							},
							{
								name: 'Single Column',
								value: 'SINGLE_COLUMN',
								description: 'Assume a single column of text of variable sizes, such as a table, chapter index or invoice'
							},
							{
								name: 'Single Line',
								value: 'SINGLE_LINE',
								description: 'Treat the image as a single text line'
							},
							{
								name: 'Single Word',
								value: 'SINGLE_WORD',
								description: 'Treat the image as a single word'
							},
							{
								name: 'Sparse Text',
								value: 'SPARSE_TEXT',
								description: 'Find as much text as possible in no particular order. Use when text is scattered across the image.'
							},
						]
					},
					{
						displayName: 'Resolution',
						name: 'resolution',
						type: 'fixedCollection',
						description: 'Customize resolution',
						typeOptions: {
							multipleValues: false
						},
						default: {resolution: {}},
						options: [
							{
								displayName: 'Resolution',
								name: 'resolution',
								values: [
									{
										displayName: 'Force Specific Resolution',
										name: 'forceResolution',
										type: 'boolean',
										default: false,
										noDataExpression: true,
										description: 'Whether to force a specific resolution (default is to let Tesseract autodetect it)',
									},
									{
										displayName: 'New Resolution',
										name: 'dpi',
										type: 'number',
										default: 300,
										typeOptions: {
											minValue: 1
										},
										displayOptions: {
											show: {
												forceResolution: [true],
											}
										},
									},
								]
							}
						]
					},
					{
						displayName: 'Character Lists',
						name: 'charlists',
						type: 'fixedCollection',
						typeOptions: {
							multipleValues: false
						},
						default: {charlists: {}},
						options: [
							{
								displayName: 'Character Lists',
								name: 'charlists',
								values: [
									{
										displayName: 'Only Allow Some Characters',
										name: 'enableWhitelist',
										type: 'boolean',
										default: false,
										noDataExpression: true,
										description: 'Whether to only recognize some characters',
									},
									{
										displayName: 'Allowed Characters',
										name: 'whitelist',
										type: 'string',
										description: 'A string containing the allowed characters, one after the other',
										placeholder: 'e.g. AEIOU',
										default: '',
										displayOptions: {
											show: {
												enableWhitelist: [true],
											}
										},
									},
									{
										displayName: 'Ensure you include a space in the allowed characters if you want the recognized text to be split by words',
										name: 'spaceWhitelistNotice',
										default: '',
										type: 'notice',
										displayOptions: {
											show: {
												enableWhitelist: [true],
												'/granularity': ['words']
											},
										},
									},
									{
										displayName: 'Disallow Some Characters',
										name: 'enableBlacklist',
										type: 'boolean',
										default: false,
										noDataExpression: true,
										description: 'Whether to ignore some characters',
									},
									{
										displayName: 'Disallowed Characters',
										name: 'blacklist',
										type: 'string',
										description: 'A string containing the ignored characters, one after the other',
										placeholder: 'e.g. AEIOU',
										default: '',
										displayOptions: {
											show: {
												enableBlacklist: [true],
											}
										},
									},
								]
							}
						]
					},
					{
						displayName: 'Timeout',
						name: 'timeout',
						type: 'number',
						description: 'If set, processing will be canceled if an image takes more than this number of milliseconds',
						default: null,
					},
					{
						displayName: 'Resize Factor',
						name: 'resizeFactor',
						type: 'number',
						description: 'Tesseract recommends that lowercase letters are around 20 pixels high. See <a href="https://github.com/tesseract-ocr/tessdoc/blob/main/tess3/FAQ-Old.md#is-there-a-minimum--maximum-text-size-it-wont-read-screen-text">this FAQ</a>. 100 keeps image as-is, lower numbers make the image smaller, higher numbers enlarge the image.',
						default: 100,
					},
					{
						displayName: 'Include Binary Output',
						name: 'outputBinary',
						type: 'boolean',
						description: 'Whether to include the processed image in the output items as Binary data. Unset this if processing large or many images.',
						default: true,
					},
					{
						displayName: 'Minimum Confidence',
						name: 'minConfidence',
						type: 'number',
						default: 0,
						description: 'Any results whose confidence is lower than this value will be discarded (confidence must be ≥ this value)',
					},
				]
			}
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const outputItems: INodeExecutionData[] = [];
		const operation = this.getNodeParameter('operation', 0, 'ocr') as 'ocr' | 'boxes';
		const lang = this.getNodeParameter('options.language', 0, 'eng') as string;

		const worker = await createWorker(lang);

		const psm = this.getNodeParameter('options.psm', 0, 'SINGLE_BLOCK') as 'SINGLE_BLOCK' | 'SINGLE_COLUMN' | 'SINGLE_LINE' | 'SINGLE_WORD' | 'SPARSE_TEXT';
		await worker.setParameters({tessedit_pageseg_mode: PSM[psm]})

		const shouldForceResolution = this.getNodeParameter('options.resolution.resolution.forceResolution', 0, false) as boolean;
		if (shouldForceResolution) {
			const newResolution = this.getNodeParameter('options.resolution.resolution.dpi', 0, 300) as number;
			await worker.setParameters({user_defined_dpi: newResolution.toFixed()})
		}

		if (this.getNodeParameter('options.charlists.charlists.enableBlacklist', 0, false)) {
			const tessedit_char_blacklist = this.getNodeParameter('options.charlists.charlists.blacklist', 0, "") as string;
			this.logger.debug('Setting blacklist', {value: tessedit_char_blacklist})
			await worker.setParameters({tessedit_char_whitelist: tessedit_char_blacklist})
		}
		if (this.getNodeParameter('options.charlists.charlists.enableWhitelist', 0, false)) {
			const tessedit_char_whitelist = this.getNodeParameter('options.charlists.charlists.whitelist', 0, "") as string;
			this.logger.debug('Setting whitelist', {value: tessedit_char_whitelist})
			await worker.setParameters({tessedit_char_whitelist})
		}

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				let newItems: INodeExecutionData[];
				const imageFieldName = this.getNodeParameter('inputDataFieldName', itemIndex, 'data') as string;
				const entireImage = this.getNodeParameter('detectEntireImage', itemIndex, true) as boolean;
				let bbox;
				if (!entireImage) {
					bbox = {
						top: this.getNodeParameter('top', itemIndex, 0) as number,
						left: this.getNodeParameter('left', itemIndex, 0) as number,
						width: this.getNodeParameter('width', itemIndex, 100) as number,
						height: this.getNodeParameter('height', itemIndex, 100) as number,
					}
				}
				const timeout = this.getNodeParameter('options.timeout', itemIndex, 0) as number;
				const resizeFactor = this.getNodeParameter('options.resizeFactor', itemIndex, 100) as number
				const minConfidence = this.getNodeParameter("options.minConfidence", itemIndex, 0) as number
				const options: OCROptions = {
					bbox,
					timeout,
					resizeFactor,
					minConfidence
				}
				switch (operation) {
					case "ocr":
						newItems = await performOCR.apply(this, [worker, items[itemIndex], itemIndex, imageFieldName, options]);
						break;
					case "boxes":
						const granularity = this.getNodeParameter('granularity', itemIndex, 'words') as "paragraphs" | "lines" | "words" | "symbols";
						newItems = await extractBoxes.apply(this, [worker, items[itemIndex], itemIndex, imageFieldName, granularity, options]);
						break;
				}

				const outputBinary = this.getNodeParameter("options.outputBinary", itemIndex, true) as boolean
				if (!outputBinary) { // clear the Binary data for all output items
					newItems.forEach(i => i.binary = {})
				}

				outputItems.push(...newItems);
				let failedItem;
				if ((failedItem = newItems.find(item => item.json?.timeout === true)) !== undefined) {
					throw new NodeOperationError(this.getNode(), failedItem.json as JsonObject, {
						itemIndex,
						message: "Timeout while OCRing item"
					})
				}
			} catch (error) {
				if (this.continueOnFail()) {
					outputItems.push({
						json: items[itemIndex].json,
						binary: this.getInputData()[itemIndex]?.binary,
						error,
						pairedItem: itemIndex
					});
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

		return [outputItems];
	}
}

