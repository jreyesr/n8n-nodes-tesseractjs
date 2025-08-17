import {IExecuteFunctions, INodeExecutionData, NodeOperationError} from "n8n-workflow";
import type {Worker, Block} from "tesseract.js";
import {getDocument, ImageKind, OPS} from "pdfjs-dist/legacy/build/pdf.mjs";
import {Jimp} from 'jimp'
import {setTimeout} from "timers";

type PdfJsImage = {
	data: Uint8ClampedArray,
	width: number, height: number,
	dataLen: number,
	kind: typeof ImageKind[keyof typeof ImageKind],
}

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

type ImageWithName = { data: Buffer, name: string, mimetype: string }

async function pdfImageToJpeg(this: IExecuteFunctions, image: PdfJsImage): Promise<Buffer> {
	const pixelSize = {
		[ImageKind.GRAYSCALE_1BPP]: 1,
		[ImageKind.RGB_24BPP]: 3,
		[ImageKind.RGBA_32BPP]: 4
	}[image.kind]

	const pixels_ = Array(image.width * image.height * 4); // preallocate RGBA
	for (let i = 0; i < image.width * image.height; i++) {
		if (pixelSize === 1) {
			const grayValue = image.data[i]
			pixels_[4 * i] = pixels_[4 * i + 1] = pixels_[4 * i + 2] = grayValue
		} else {
			const [r, g, b] = image.data.slice(i * pixelSize, i * pixelSize + 3)
			pixels_[4 * i] = r
			pixels_[4 * i + 1] = g
			pixels_[4 * i + 2] = b
		}
		pixels_[4 * i + 3] = 0xff // alpha channel is always 0xff
	}
	const jimp: InstanceType<(typeof Jimp)> = Jimp.fromBitmap({
		data: Buffer.from(pixels_),
		width: image.width, height: image.height
	})
	const jpeg = await jimp.getBuffer("image/jpeg")
	this.logger.debug("encoded to JPG", {size: jpeg.length})
	return jpeg
}

async function getImagesFromBinary(this: IExecuteFunctions, itemIndex: number, imageFieldName: string): Promise<ImageWithName[]> {
	this.logger.debug("Getting images", {itemIndex})
	const binaryInfo = this.getInputData()[itemIndex].binary![imageFieldName]
	const buffer = await this.helpers.getBinaryDataBuffer(itemIndex, imageFieldName)
	if (binaryInfo.mimeType.startsWith("image/")) {
		return [{data: buffer, mimetype: binaryInfo.mimeType, name: binaryInfo.fileName!}]
	} else if (binaryInfo.mimeType === "application/pdf") {
		const pdfDoc = await getDocument(Uint8Array.from(buffer)).promise
		const imageBufferPromises: Promise<ImageWithName>[] = []

		// NOTE: PDF page numbers start at 1!
		for (let pageNumber = 1; pageNumber <= pdfDoc.numPages; pageNumber++) {
			this.logger.debug("Getting images in page", {pageNumber})
			const page = await pdfDoc.getPage(pageNumber)
			const operators = await page.getOperatorList()
			// operators has two parallel arrays, fnArray and argsArray, equivalent to calling fnArray[i](...argsArray[i]) for each i
			for (let i = 0; i < operators.fnArray.length; i++) {
				if (operators.fnArray[i] == OPS.paintImageXObject) { // NOTE: You may find references to paintJpegXObject, it's now deprecated
					const imgIndex: string = operators.argsArray[i][0];
					this.logger.debug("Found image in page", {pageNumber, imgIndex})
					imageBufferPromises.push(new Promise<ImageWithName>(resolve => {
						// NOTE: images whose IDs start with "g_" indicate that they're cached at the document level
						// This happens for images that appear on several pages, at which point PDF.js moves them from the page object store to the doc object store
						// Those images need to be accessed from `page.commonObjs` rather than `page.objs`, if you try to access `page.objs` the callback is simply
						// never called and this whole function hangs
						// See https://github.com/mozilla/pdf.js/issues/13742#issuecomment-881297161
						(imgIndex.startsWith("g_") ? page.commonObjs : page.objs).get(imgIndex, async (imgRef: PdfJsImage) => {
							resolve({
								data: await pdfImageToJpeg.apply(this, [imgRef]),
								name: imgIndex.toString() + ".jpg",
								mimetype: "image/jpeg",
							})
						})
					}))
				}
			}
		}

		return Promise.all(imageBufferPromises).catch(e => {
			this.logger.error("ERR", {e});
			return [];
		})
	} else {
		throw new NodeOperationError(this.getNode(), {}, {
			itemIndex,
			message: `Binary property ${imageFieldName} must be either an image or a PDF document, was ${binaryInfo.mimeType} instead`
		})
	}
}


export async function performOCR(this: IExecuteFunctions, worker: Worker, item: INodeExecutionData, itemIndex: number, imageFieldName: string, bbox?: BoundingBox, timeout: number = 0): Promise<INodeExecutionData[]> {
	const images = await getImagesFromBinary.apply(this, [itemIndex, imageFieldName])
	this.logger.debug("images fetched", {num: images.length})
	const processImage = async ({data: image, name, mimetype}: ImageWithName) => {
		this.logger.debug("Processing image", {name, size: image.length})

		const newItem: INodeExecutionData = {
			json: {},
			binary: {...item.binary}, // clone because otherwise the multiple items of a PDF will step on each other
			pairedItem: {item: itemIndex}
		};

		const d = await withTimeout(
			worker.recognize(image, {rectangle: bbox}, {text: true}),
			timeout,
			async () => {
				await worker.terminate()
			})
		this.logger.debug("Image processed", {name})

		newItem.json =
			d === "timeout" ?
				{timeout: true} :
				{text: d.data.text, confidence: d.data.confidence};
		newItem.binary!["ocr"] = await this.helpers.prepareBinaryData(image, name, mimetype)
		return newItem;
	}

	return Promise.all(images.map(processImage))
}

export async function extractBoxes(this: IExecuteFunctions, worker: Worker, item: INodeExecutionData, itemIndex: number, imageFieldName: string, granularity: "paragraphs" | "lines" | "words" | "symbols", bbox?: BoundingBox, timeout: number = 0): Promise<INodeExecutionData[]> {
	const images = await getImagesFromBinary.apply(this, [itemIndex, imageFieldName])
	const processImage = async ({data: image, name, mimetype}: ImageWithName) => {
		const newItem: INodeExecutionData = {
			json: {},
			binary: {...item.binary},
			pairedItem: itemIndex
		};

		const d = await withTimeout(
			worker.recognize(image, {rectangle: bbox}, {blocks: true}),
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
			newItem.binary!["ocr"] = await this.helpers.prepareBinaryData(image, name, mimetype)
		}
		return newItem;
	}

	return Promise.all(images.map(processImage))
}
