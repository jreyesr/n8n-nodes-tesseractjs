import {IExecuteFunctions, INodeExecutionData, NodeOperationError} from "n8n-workflow";
import type {Worker, Block} from "tesseract.js";
import {getDocument, ImageKind, OPS} from "pdfjs-dist/legacy/build/pdf.mjs";
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

function pdfImageToBmp(image: PdfJsImage): Buffer {
	function toLittleEndian(n: number): Uint8Array {
		return Uint8Array.from([n & 255, (n >> 8 & 255), (n >> 16 & 255), (n >> 24 & 255)])
	}

	function toLittleEndianHalf(n: number): Uint8Array {
		return toLittleEndian(n).slice(0, 2)
	}

	// each row must be padded to 4 bytes, so we may need to add something
	const rowPadding = (4 - image.width * 3 % 4) % 4 // each pixel will always use 3 bytes, see below
	const bmpRowLength = image.width * 3 + rowPadding
	const bmpFinalSize = 54 + bmpRowLength * image.height

	// critical reference: https://en.wikipedia.org/wiki/BMP_file_format#Example_1
	const pieces: Uint8Array[] = []

	// BMP header, 14 bytes
	pieces.push(Buffer.from("BM"))
	pieces.push(toLittleEndian(bmpFinalSize))
	pieces.push(toLittleEndian(0)) // 4 zero bytes, "application specific"
	pieces.push(toLittleEndian(54)) // offset where pixel data starts
	// DIB header, 40 bytes
	pieces.push(toLittleEndian(40)) // size of this header
	pieces.push(toLittleEndian(image.width))
	pieces.push(toLittleEndian(image.height))
	pieces.push(toLittleEndianHalf(1)) // 1 color plane
	pieces.push(toLittleEndianHalf(24)) // 24 bpp
	pieces.push(toLittleEndian(0)) // 0 = no pixel array compression
	pieces.push(toLittleEndian(bmpRowLength * image.height))
	pieces.push(toLittleEndian(2835)) // dpi, horizontal, 72 DPI
	pieces.push(toLittleEndian(2835)) // dpi, vertical, 72 DPI
	pieces.push(toLittleEndian(0)) // num colors in palette
	pieces.push(toLittleEndian(0)) // 0 = all colors are important

	// fill pixel data
	const pixelSize = {
		[ImageKind.GRAYSCALE_1BPP]: 1,
		[ImageKind.RGB_24BPP]: 3,
		[ImageKind.RGBA_32BPP]: 4
	}[image.kind]
	for (let row = image.height; row >= 0; row--) { // NOTE: BMP is stored bottom to top (why, MS?)
		let bytesSaved = 0
		for (let col = 0; col < image.width; col++) {
			const startPositionInSource = row * image.width * pixelSize + col * pixelSize
			if (pixelSize === 1) {
				// copy the same gray value three times
				pieces.push(Uint8Array.from(Array(3).fill(image.data[startPositionInSource])))
			} else {
				// either RGB or RGBA, just copy the first three bytes (RGB), and wholly ignore A if it exists
				// WARN: BMP stores in reverse order, BGR (why, MS? x2)
				pieces.push(Uint8Array.from(image.data.slice(startPositionInSource, startPositionInSource + 3).reverse()))
			}
			bytesSaved += 3
		}

		// NOTE: may be zero, shouldn't hurt anything in that case
		pieces.push(Uint8Array.from(Array(rowPadding).fill(0)))
	}

	return Buffer.concat(pieces)
}

async function getImagesFromBinary(this: IExecuteFunctions, itemIndex: number, imageFieldName: string): Promise<ImageWithName[]> {
	const binaryInfo = this.getInputData()[itemIndex].binary![imageFieldName]
	const buffer = await this.helpers.getBinaryDataBuffer(itemIndex, imageFieldName)
	if (binaryInfo.mimeType.startsWith("image/")) {
		return [{data: buffer, mimetype: binaryInfo.mimeType, name: binaryInfo.fileName!}]
	} else if (binaryInfo.mimeType === "application/pdf") {
		const pdfDoc = await getDocument(Uint8Array.from(buffer)).promise
		const imageBufferPromises: Promise<ImageWithName>[] = []

		// NOTE: PDF page numbers start at 1!
		for (let pageNumber = 1; pageNumber <= pdfDoc.numPages; pageNumber++) {
			const page = await pdfDoc.getPage(pageNumber)
			const operators = await page.getOperatorList()
			// operators has two parallel arrays, fnArray and argsArray, equivalent to calling fnArray[i](...argsArray[i]) for each i
			for (let i = 0; i < operators.fnArray.length; i++) {
				if (operators.fnArray[i] == OPS.paintImageXObject) { // NOTE: You may find references to paintJpegXObject, it's now deprecated
					const imgIndex = operators.argsArray[i][0];
					imageBufferPromises.push(new Promise<ImageWithName>(resolve => {
						page.objs.get(imgIndex, (imgRef: PdfJsImage) => resolve({
							data: pdfImageToBmp(imgRef),
							name: imgIndex.toString() + ".bmp",
							mimetype: "image/bmp",
						}))
					}))
				}
			}
		}

		return Promise.all(imageBufferPromises)
	} else {
		throw new NodeOperationError(this.getNode(), {}, {
			itemIndex,
			message: `Binary property ${imageFieldName} must be either an image or a PDF document, was ${binaryInfo.mimeType} instead`
		})
	}
}


export async function performOCR(this: IExecuteFunctions, worker: Worker, item: INodeExecutionData, itemIndex: number, imageFieldName: string, bbox?: BoundingBox, timeout: number = 0): Promise<INodeExecutionData[]> {
	const images = await getImagesFromBinary.apply(this, [itemIndex, imageFieldName])
	const processImage = async ({data: image, name, mimetype}: ImageWithName) => {
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
