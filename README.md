# n8n-nodes-tesseractjs

This is a n8n community node. It lets you use [Tesseract.js](https://tesseract.projectnaptha.com/) in your n8n
workflows.

[Tesseract](https://github.com/tesseract-ocr/tesseract?tab=readme-ov-file#about) is an open source OCR (Optical
Character Recognition) engine that can recognize text (machine/typed/printed text, not handwritten) in images (e.g. PNG
or JPEG).

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/reference/license/) workflow automation platform.

[Installation](#installation)  
[Operations](#operations)  
[Compatibility](#compatibility)  
[Usage](#usage)  <!-- delete if not using this section -->  
[Resources](#resources)  
[Version history](#version-history)  <!-- delete if not using this section -->

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community
nodes documentation.

## Operations

### Extract text

This operation reads the text of the entire image. It outputs a JSON item containing the entire recognized text, and a "
confidence value" indicating how likely the generated text is to match the source image, as a percentage:

```json
{
	"text": "...",
	"confidence": 94
}
```

### Extract boxes

This operation also reads text, but returns more information about the bounding box of each detected block, and the
detected
language if available.

The "granularity" of the detections can be controlled: you can split on paragraphs, lines, words or individual
characters.

```json
{
	"blocks": [
		{
			"text": "This",
			"confidence": 95.15690612792969,
			"bbox": {
				"x0": 36,
				"y0": 92,
				"x1": 96,
				"y1": 116
			},
			"language": "eng"
		},
		{
			"text": "is",
			"confidence": 95.15690612792969,
			"bbox": {
				"x0": 109,
				"y0": 92,
				"x1": 129,
				"y1": 116
			},
			"language": "eng"
		},
		...
	]
}
```

![an image of some text with Tesseract detections overlaid. Each word is surrounded in a light red box, and each box also has text on top indicating the detected word and confidence percentage](imgs/words.png)

Entire paragraphs:

![an image of the same text with Tesseract per-paragraph detections overlaid as one red box covering each paragraph](imgs/paragraphs.png)

Per-line statistics:

![an image of the same text with Tesseract per-line detections overlaid as one red box covering each line](imgs/lines.png)

## Compatibility

This node has been tested on n8n v1.68.0, but should also work on older versions. If you encounter an issue with an
older version, please [raise an issue](https://github.com/jreyesr/n8n-nodes-tesseractjs/issues).

## Usage

### Input Image Field Name

All Operations of this node have a field **Input Image Field Name**, where the _name_ of a Binary item should be
provided:

![a screenshot of the node UI showing an input item with Binary data](imgs/iifn.png)

The Binary file with that name will be read and processed.

### Detect on Entire Image?

It's possible to limit the OCR to a certain segment of an image, by toggling the **Detect on Entire Image?** switch
to Off. When doing so, it's necessary to provide the top and left coordinates of the desired bounding box, and the width
and height of the box. For example:

![a screenshot of the node settings showing that when the Detect on Entire Image switch is Off, there are fields to provide the top, left, width and height of the desired bounding box](imgs/bbox.png)

This could delineate a region like this:

![an image with some text and a light green box that covers only part of it](imgs/bbox_vis.png)

When performing OCR on that region, it'd only return the text that was contained in that box, even truncating words of
they lie halfway across the bounding box's borders:

![an image with some text and the OCR detections overlaid, showing that only text that lies inside the area of interest has been recognized](imgs/bbox_ocr.png)

## Resources

* [n8n community nodes documentation](https://docs.n8n.io/integrations/community-nodes/)
* [Tesseract.js's docs](https://github.com/naptha/tesseract.js/tree/master/docs)

## Version history

### v1.0.0

Initial version, contains the **Extract text** and **Extract boxes** operations.

## Developer info

### Releasing changes

1. Bump the version in package.json. We use SemVer.
2. Add an entry to the top of CHANGELOG.md describing the changes.
3. Push changes, open a PR and merge it to master branch (if developing on another branch)
4. Create a release. This will kick off the CI which will build and publish the package on NPM
