import {IExecuteFunctions, INodeExecutionData, NodeOperationError} from "n8n-workflow";
import type {Block, Worker} from "tesseract.js";
import {PDFArray, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef} from 'pdf-lib'
import {Jimp, JimpInstance} from 'jimp'
import {setTimeout} from "timers";
import {inflate} from "pako";


type BoundingBox = {
	top: number, left: number,
	width: number, height: number,
}

export type OCROptions = {
	bbox?: BoundingBox
	timeout: number
	resizeFactor?: number
	minConfidence: number
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

type ImageWithName = { data: Buffer, name: string, mimetype: string, ref?: PDFRef, maskRef?: PDFRef }

async function processPDFImage(this: IExecuteFunctions, doc: PDFDocument, ref: PDFRef, obj: PDFRawStream): Promise<ImageWithName | undefined> {
	const {dict} = obj;
	const smaskRef = dict.get(PDFName.of("SMask")) as PDFRef | undefined;
	const colorSpace = dict.get(PDFName.of("ColorSpace")) as PDFName | PDFRef;
	const width = (dict.get(PDFName.of("Width")) as PDFNumber).asNumber();
	const height = (dict.get(PDFName.of("Height")) as PDFNumber).asNumber();
	const name = dict.get(PDFName.of("Name")) as PDFName | undefined;
	const bitsPerComponent = (dict.get(PDFName.of("BitsPerComponent")) as PDFNumber).asNumber();
	const filter = dict.get(PDFName.of("Filter"));

	// there are some possibilities, all apply only to streams with Type=/XObject, Subtype=/Image
	// 1. Filter=/DCTDecode => It's a raw JPEG, can be passed directly to Tesseract
	// 2. Filter=/FlateDecode => Raw bitmap, I think? (Not JPEG, not PNG, just array of bytes, zlib-compressed
	// 		2.a. ColorSpace=/DeviceGray, BitsPerComponent=1 => probably a binary mask for another image
	//    2.b. ColorSpace=/DeviceGray, BitsPerComponent=8 => grayscale image? (haven't seen any yet)
	//    2.c. ColorSpace=/DeviceRGB, BitsPerComponent=8 => normal RGB pixels r1 g1 b1 r2 g2 b2 r3 g3 b3 ...
	//    2.d. ColorSpace=[/Indexed /DeviceRGB <2^N-1> (palette)] , BitsPerComponent=N => RGB pixels but image data is
	//         indices into palette ix1 ix2 ix3 ..., palette is another stream (usually also with Filter=/FlateDecode) with 2^N-1 R+G+B values
	const image: Partial<ImageWithName> = {name: name?.asString() ?? `Object${ref}`, ref: ref, maskRef: smaskRef}

	this.logger.debug('reading image', {name: image.name, ref, filter, colorSpace, bitsPerComponent})

	switch (filter) {
		case PDFName.of("DCTDecode"): // JPEG
			image.mimetype = "image/jpeg"
			image.data = Buffer.from(obj.contents)
			return image as ImageWithName
		case PDFName.of("FlateDecode"): // probably raw image data in one of many, many shapes
			image.mimetype = "image/png"
			const rawPixels = inflate(obj.contents)
			let jimpImage: JimpInstance
			switch (true) {
				case colorSpace === PDFName.of("DeviceGray"): // 1-bit (binary) or 8-bit (grayscale) images
					let rgbaImage: Uint8Array
					if (bitsPerComponent === 1) {
						// binary image
						rgbaImage = new Uint8Array(width * height * 4)
						// rawPixels is like this:
						// data   |abcdefgh|abcdefgh|...
						// i      |   0    |   1    |...
						// j      |01234567|01234567|...
						for (let i = 0; i < rawPixels.length; i++) { // each i grabs a bunch of 8 pixels
							for (let j = 0; j < 8; j++) { // j chooses each pixel in the bunch
								// e.g. for i=1, j=3, then rawPixels[1] & (1 << 4) = rawPixels[1] & 00010000 = picks the 12th pixel in the source array
								// then multiply by 255 so 0 => 0 and 1 => 255, which are the only two possible values
								const px = (rawPixels[i] & (1 << (7 - j))) > 0 ? 255 : 0
								rgbaImage.set([px, px, px, 255], (i * 8 + j) * 4)
							}
						}
					} else if (bitsPerComponent === 8) {
						// grayscale image, just repeat each pixel value 3 times for RGB and add one 255 for alpha channel
						rgbaImage = new Uint8Array(width * height * 4)
						for (let i = 0; i < width * height; i++) {
							rgbaImage.set([rawPixels[i], rawPixels[i], rawPixels[i], 255], i * 4)
						}
					} else {
						this.logger.warn('unhandled bits-per-pixel for grayscale image', {
							ref,
							name,
							filter,
							colorSpace,
							bitsPerComponent
						})
						return
					}

					jimpImage = Jimp.fromBitmap({
						data: Buffer.from(rgbaImage),
						width,
						height
					})
					break
				case colorSpace === PDFName.of("DeviceRGB"): // your standard full-color RGB image
					const rgbaImage2 = new Uint8Array(width * height * 4)
					for (let i = 0; i < width * height; i++) {
						rgbaImage2.set(rawPixels.subarray(i * 3, i * 3 + 3), i * 4) // copy three bytes for RGB
						rgbaImage2[i * 4 + 3] = 255 // and hard-code alpha as 255
					}

					jimpImage = Jimp.fromBitmap({
						data: Buffer.from(rgbaImage2),
						width,
						height
					})
					break
				case colorSpace instanceof PDFRef: // indexed images (colors live in a separate "palette", pixel values are indices into said palette)
					const colorSpaceObject = doc.context.lookup(colorSpace) as PDFArray
					if (colorSpaceObject.get(0) !== PDFName.of("Indexed") || colorSpaceObject.get(1) !== PDFName.of("DeviceRGB")) {
						this.logger.warn('unhandled indexed/palette image data', {
							ref,
							name,
							filter,
							colorSpaceObject,
							bitsPerComponent
						})
						return
					}

					const paletteSize = (colorSpaceObject.get(2) as PDFNumber).asNumber() + 1 // e.g. 16 for 4-bit indices (16 colors max)
					const paletteRaw: Uint8Array = inflate((doc.context.lookup(colorSpaceObject.get(3)) as PDFRawStream).contents)
					// palette is a DataView because we want to set it as UInt8Array but read it as UInt32Array
					const palette = new DataView(new ArrayBuffer(paletteSize * 4))
					for (let i = 0; i < paletteSize; i++) {
						palette.setUint8(i * 4, paletteRaw[i * 3])
						palette.setUint8(i * 4 + 1, paletteRaw[i * 3 + 1])
						palette.setUint8(i * 4 + 2, paletteRaw[i * 3 + 2])
						palette.setUint8(i * 4 + 3, 255)
					}

					const indicesImage = new Uint8Array(width * height)
					// some common possibilities:
					// * bitsPerComponent = 1 = 2-color image => 8 pixels on each byte of rawPixels
					// * bitsPerComponent = 4 = at most 16 colors => each byte of rawPixels has 2 actual pixels
					// * bitsPerComponent = 8 = 256-color => 1-to-1 mapping between rawPixels and the actual pixels
					const pixelsPerByte = 8 / bitsPerComponent
					for (let i = 0; i < indicesImage.length; i++) {
						const sourceByte = Math.trunc(i / pixelsPerByte)
						const offsetInByte = i % pixelsPerByte
						const displacement = (pixelsPerByte - offsetInByte - 1) * bitsPerComponent
						// pick e.g. 1, 4 or 8 bits from that position, starting at offsetInByte
						// 2^bitsPerComponent-1 becomes 0b111...1 with as many 1s as the number in bitsPerComponent
						// e.g. if bitsPerComponent=4 then mask=2^4-1=15=0b1111 which has 4 1s
						// Then displace mask sideways to pick the appropriate nibble/bit/... sub-byte portion
						const pixelMask = (2 ** bitsPerComponent - 1) << displacement

						// e.g. bitsPerPixel=4 and we're asking for indices[2] (3rd pixel) which is stored on first half of second byte
						// pixelsPerByte = 2
						// sourceByte = trunc(2/2) = 1, offsetInByte = 1 % 2 = 0, displacement = 4
						// rawPixels[1]  abcdefgh
						// mask          11110000 (= 0b1111 << 4)
						// AND           abcd0000 , then >> 4
						// indices[2]    0000abcd
						indicesImage[i] = (rawPixels[sourceByte] & pixelMask) >> displacement
					}
					jimpImage = new Jimp({width, height})
					jimpImage.scan((x: number, y: number) => { // fill the image with the correct colors from the palette
						const idx = x + y * width
						jimpImage.setPixelColor(palette.getUint32(indicesImage[idx] * 4), x, y)
					})
					break
				default:
					this.logger.warn('unhandled zlib-compressed image data', {
						ref,
						name,
						filter,
						colorSpace,
						bitsPerComponent
					})
					return
			}

			if (smaskRef) {
				const jimpImageMask = await Jimp.fromBuffer((await processPDFImage.call(this, doc, smaskRef, doc.context.lookup(smaskRef) as PDFRawStream))!.data)
				// @ts-ignore
				jimpImage = jimpImage.mask(jimpImageMask)
			}

			image.data = await jimpImage.getBuffer("image/png")
			return image as ImageWithName
		default:
			this.logger.warn('unhandled image config', {ref, name, filter, colorSpace, bitsPerComponent})
			return
	}
}

async function getImagesFromBinary(this: IExecuteFunctions, itemIndex: number, imageFieldName: string, resizeFactor: number = 100): Promise<ImageWithName[]> {
	this.logger.debug("Getting images", {itemIndex})
	const binaryInfo = this.getInputData()[itemIndex].binary![imageFieldName]
	const buffer = await this.helpers.getBinaryDataBuffer(itemIndex, imageFieldName)
	if (binaryInfo.mimeType.startsWith("image/")) {
		let resized = buffer, mimeType = binaryInfo.mimeType;
		if (resizeFactor !== 100) {
			resized = await (await Jimp.fromBuffer(buffer)).scale(resizeFactor / 100).getBuffer("image/jpeg")
			mimeType = "image/jpeg"
		}
		return [{data: resized, mimetype: mimeType, name: binaryInfo.fileName!}]
	} else if (binaryInfo.mimeType === "application/pdf") {
		const pdfDoc = await PDFDocument.load(buffer)
		const imagePromises: Promise<ImageWithName | undefined>[] = []

		pdfDoc.context
			.enumerateIndirectObjects()
			.forEach(([pdfRef, pdfObject], ref) => {
				if (!(pdfObject instanceof PDFRawStream) || pdfObject.dict.get(PDFName.of("Subtype")) !== PDFName.of("Image")) {
					return;
				}
				imagePromises.push(processPDFImage.call(this, pdfDoc, pdfRef, pdfObject))
			});

		const allImages = (await Promise.all(imagePromises)).filter(img => img !== undefined)

		const maskRefs = new Set<PDFRef>(allImages.filter(img => img.maskRef !== undefined).map(img => img.maskRef!))
		this.logger.debug('mask images', {maskRefs})

		return allImages.filter(img => !maskRefs.has(img.ref!))
	} else {
		throw new NodeOperationError(this.getNode(), {}, {
			itemIndex,
			message: `Binary property ${imageFieldName} must be either an image or a PDF document, was ${binaryInfo.mimeType} instead`
		})
	}
}


export async function performOCR(this: IExecuteFunctions, worker: Worker, item: INodeExecutionData, itemIndex: number, imageFieldName: string, options: OCROptions): Promise<INodeExecutionData[]> {
	const images = await getImagesFromBinary.apply(this, [itemIndex, imageFieldName, options.resizeFactor ?? 100])
	this.logger.debug("images fetched", {num: images.length})
	const processImage = async ({data: image, name, mimetype}: ImageWithName) => {
		this.logger.debug("Processing image", {name, size: image.length})

		const newItem: INodeExecutionData = {
			json: {},
			binary: {...item.binary}, // clone because otherwise the multiple items of a PDF will step on each other
			pairedItem: {item: itemIndex}
		};

		const d = await withTimeout(
			worker.recognize(image, {rectangle: options.bbox}, {text: true}),
			options.timeout ?? 0,
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

	const imagesData = await Promise.all(images.map(processImage))
	// if item.json does not have .confidence, it'll fallback to options.minConfidence, which is always >= itself,
	// therefore items without .confidence (i.e. timeouts) will always be returned
	return imagesData.filter(imageData => (imageData.json.confidence as number ?? options.minConfidence) >= options.minConfidence)
}

export async function extractBoxes(this: IExecuteFunctions, worker: Worker, item: INodeExecutionData, itemIndex: number, imageFieldName: string, granularity: "paragraphs" | "lines" | "words" | "symbols", options: OCROptions): Promise<INodeExecutionData[]> {
	const images = await getImagesFromBinary.apply(this, [itemIndex, imageFieldName, options.resizeFactor ?? 100])
	const processImage = async ({data: image, name, mimetype}: ImageWithName) => {
		const newItem: INodeExecutionData = {
			json: {},
			binary: {...item.binary},
			pairedItem: itemIndex
		};

		const d = await withTimeout(
			worker.recognize(image, {rectangle: options.bbox}, {blocks: true}),
			options.timeout ?? 0,
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
				blocks: (d.data[granularity]
					.map((b: Block) => ({
						text: b.text,
						confidence: b.confidence,
						bbox: b.bbox,
						language: "language" in b ? b.language : undefined
					}))
					.filter((blockInfo: {
						confidence?: number
					}) => (blockInfo.confidence ?? options.minConfidence) >= options.minConfidence))
			};
			newItem.binary!["ocr"] = await this.helpers.prepareBinaryData(image, name, mimetype)
		}
		return newItem;
	}

	return Promise.all(images.map(processImage))
}
