import {IExecuteFunctions, INodeExecutionData} from "n8n-workflow";
import type {Worker, Block} from "tesseract.js";
import {setTimeout} from "timers";

type BoundingBox = {
	top: number, left: number,
	width: number, height: number,
}

async function withTimeout<T>(promise: Promise<T>, timeout: number, cleanupFunc?: () => Promise<void>): Promise<T | "timeout"> {
	if (!timeout) return promise;

	return Promise.race([
		promise,
		new Promise<"timeout">((resolve) => setTimeout(async () => {
			if (cleanupFunc) await cleanupFunc()
			resolve("timeout")
		}, timeout))
	])
}


export async function performOCR(this: IExecuteFunctions, worker: Worker, item: INodeExecutionData, itemIndex: number, imageFieldName: string, bbox?: BoundingBox, timeout: number = 0): Promise<INodeExecutionData> {
	const newItem: INodeExecutionData = {
		json: {},
		binary: item.binary,
		pairedItem: item.index
	};

	const data = await this.helpers.getBinaryDataBuffer(itemIndex, imageFieldName)
	const d = await withTimeout(
		worker.recognize(data, {rectangle: bbox}, {text: true}),
		timeout,
		async () => {
			await worker.terminate()
		})

	newItem.json =
		d === "timeout" ?
			{timeout: true} :
			{text: d.data.text, confidence: d.data.confidence};
	return newItem;
}

export async function extractBoxes(this: IExecuteFunctions, worker: Worker, item: INodeExecutionData, itemIndex: number, imageFieldName: string, granularity: "paragraphs" | "lines" | "words" | "symbols", bbox?: BoundingBox, timeout: number = 0): Promise<INodeExecutionData> {
	const newItem: INodeExecutionData = {
		json: {},
		binary: item.binary,
		pairedItem: itemIndex
	};

	const data = await this.helpers.getBinaryDataBuffer(itemIndex, imageFieldName)
	const d = await withTimeout(
		worker.recognize(data, {rectangle: bbox}, {blocks: true}),
		timeout,
		async () => {
			await worker.terminate()
		})

	if (d === "timeout") {
		newItem.json = {timeout: true}
	} else {
		// NOTE: since v1.2.0, we start clobbering the nice TS object here, to restore it to the pre-v6 API, which included additional properties
		// See https://github.com/naptha/tesseract.js/issues/993#issuecomment-2597678687
		// @ts-ignore
		d.data.paragraphs = d.data.blocks!.map((block) => block.paragraphs).flat();
		// @ts-ignore
		d.data.lines = d.data.blocks!.map((block) => block.paragraphs.map((paragraph) => paragraph.lines)).flat(2);
		// @ts-ignore
		d.data.words = d.data.blocks!.map((block) => block.paragraphs.map((paragraph) => paragraph.lines.map((line) => line.words))).flat(3);
		// @ts-ignore
		d.data.symbols = d.data.blocks!.map((block) => block.paragraphs.map((paragraph) => paragraph.lines.map((line) => line.words.map((word) => word.symbols)))).flat(4);

		newItem.json = {
			// @ts-ignore
			blocks: d.data[granularity].map((b: Block) => ({
				text: b.text,
				confidence: b.confidence,
				bbox: b.bbox,
				language: "language" in b ? b.language : undefined
			}))
		};
	}
	return newItem;
}
