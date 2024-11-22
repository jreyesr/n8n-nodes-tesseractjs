import {IExecuteFunctions, INodeExecutionData} from "n8n-workflow";
import type {Worker} from "tesseract.js";

export async function performOCR(this: IExecuteFunctions, worker: Worker, item: INodeExecutionData, itemIndex: number, imageFieldName: string): Promise<INodeExecutionData> {
	const newItem: INodeExecutionData = {
		json: {},
		binary: item.binary,
		pairedItem: item.index
	};

	const data = await this.helpers.getBinaryDataBuffer(itemIndex, imageFieldName)
	const d = await worker.recognize(data, {}, {text: true});

	newItem.json = {text: d.data.text, confidence: d.data.confidence};
	return newItem;
}

export async function extractBoxes(this: IExecuteFunctions, worker: Worker, item: INodeExecutionData, itemIndex: number, imageFieldName: string, granularity: "paragraphs" | "lines" | "words" | "symbols"): Promise<INodeExecutionData> {
	const newItem: INodeExecutionData = {
		json: {},
		binary: item.binary,
		pairedItem: item.index
	};

	const data = await this.helpers.getBinaryDataBuffer(itemIndex, imageFieldName)
	const d = await worker.recognize(data);

	newItem.json = {
		blocks: d.data[granularity].map(b => ({
			text: b.text,
			confidence: b.confidence,
			bbox: b.bbox,
			language: "language" in b ? b.language : undefined
		}))
	};
	return newItem;
}
