import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { deflateSync } from "node:zlib";

import { JSDOM } from "jsdom";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

import {
  assertPdfDecodedStreamBudget,
  assertPdfPageHasRenderableContent,
  calculatePdfCanvasMetrics,
  clampPdfScale,
  consumePdfTextItemsWithinBudget,
  createPdfOperatorBudget,
  createPdfDocumentOptions,
  createPdfDocumentProbeOptions,
  decodePdfBytes,
  extractPdfPageText,
  extractPdfPageTextWithinBudget,
  hasValidPdfViewportDimensions,
  MAX_PDF_CANVAS_AREA_BYTES,
  MAX_PDF_CANVAS_DIMENSION,
  MAX_PDF_CANVAS_PIXELS,
  MAX_PDF_CSS_DIMENSION,
  MAX_PDF_DECODED_STREAM_BYTES,
  MAX_PDF_DECODED_TOTAL_BYTES,
  MAX_PDF_IMAGE_PIXELS,
  MAX_PDF_OPERATOR_WORK_PER_PAGE,
  MAX_PDF_TEXT_CHARS_PER_PAGE,
  MAX_PDF_TEXT_CHARS_TOTAL,
  MAX_PDF_TEXT_ITEMS_PER_PAGE,
  MAX_PDF_TEXT_ITEMS_TOTAL,
  MAX_PDF_WORKSPACE_PAGES,
  PDF_WORKSPACE_RENDER_INTENT,
} from "./pdfWorkspaceViewerModel.ts";
import { readActivePdfXrefOffsets } from "./pdfWorkspaceXref.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

class MockIntersectionObserver {
  static instances = [];

  constructor(callback) {
    this.callback = callback;
    this.target = null;
    MockIntersectionObserver.instances.push(this);
  }

  disconnect() {
    this.target = null;
  }

  observe(target) {
    this.target = target;
  }

  setVisible(isIntersecting) {
    if (!this.target) return;
    this.callback([{ isIntersecting, target: this.target }], this);
  }
}

before(() => {
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    HTMLCanvasElement: dom.window.HTMLCanvasElement,
    IntersectionObserver: MockIntersectionObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom.window,
  });
});

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
  MockIntersectionObserver.instances = [];
});

after(() => dom.window.close());

function deferred() {
  let reject;
  let resolve;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

function createScannedPdfFixture(width, height) {
  const rowBytes = Math.ceil(width / 8);
  const compressedImage = deflateSync(Buffer.alloc(rowBytes * height, 0xff));
  const pageContent = Buffer.from("q 595 0 0 842 0 0 cm /Im0 Do Q\n");
  const objects = [
    Buffer.from("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    Buffer.from("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
    Buffer.from(
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] " +
        "/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    ),
    Buffer.concat([
      Buffer.from(
        `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} ` +
          `/Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 1 ` +
          `/Filter /FlateDecode /Length ${compressedImage.length} >>\nstream\n`,
      ),
      compressedImage,
      Buffer.from("\nendstream\nendobj\n"),
    ]),
    Buffer.concat([
      Buffer.from(`5 0 obj\n<< /Length ${pageContent.length} >>\nstream\n`),
      pageContent,
      Buffer.from("endstream\nendobj\n"),
    ]),
  ];
  const header = Buffer.from("%PDF-1.7\n% fixture\n");
  const offsets = [];
  let offset = header.length;
  for (const object of objects) {
    offsets.push(offset);
    offset += object.length;
  }
  const xref = Buffer.from(
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
      .map((entry) => `${String(entry).padStart(10, "0")} 00000 n `)
      .join("\n")}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
      `startxref\n${offset}\n%%EOF\n`,
  );
  return new Uint8Array(Buffer.concat([header, ...objects, xref]));
}

function createBlankPdfFixture() {
  const objects = [
    Buffer.from("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    Buffer.from("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
    Buffer.from(
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>\nendobj\n",
    ),
  ];
  const header = Buffer.from("%PDF-1.7\n% blank fixture\n");
  const offsets = [];
  let offset = header.length;
  for (const object of objects) {
    offsets.push(offset);
    offset += object.length;
  }
  const xref = Buffer.from(
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
      .map((entry) => `${String(entry).padStart(10, "0")} 00000 n `)
      .join("\n")}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
      `startxref\n${offset}\n%%EOF\n`,
  );
  return new Uint8Array(Buffer.concat([header, ...objects, xref]));
}

function createFlatPageTreePdfFixture(pageCount) {
  const objects = [
    Buffer.from("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    Buffer.from(
      `2 0 obj\n<< /Type /Pages /Kids [${Array.from(
        { length: pageCount },
        (_, index) => `${index + 3} 0 R`,
      ).join(" ")}] /Count ${pageCount} >>\nendobj\n`,
    ),
    ...Array.from({ length: pageCount }, (_, index) =>
      Buffer.from(
        `${index + 3} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>\nendobj\n`,
      ),
    ),
  ];
  const header = Buffer.from("%PDF-1.7\n% flat page tree fixture\n");
  const offsets = [];
  let offset = header.length;
  for (const object of objects) {
    offsets.push(offset);
    offset += object.length;
  }
  const xref = Buffer.from(
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
      .map((entry) => `${String(entry).padStart(10, "0")} 00000 n `)
      .join("\n")}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
      `startxref\n${offset}\n%%EOF\n`,
  );
  return new Uint8Array(Buffer.concat([header, ...objects, xref]));
}

function createCompressedOperatorFloodPdfFixture(operationPairs = 1_000_000) {
  const rawContent = Buffer.from("q Q\n".repeat(operationPairs));
  const compressedContent = deflateSync(rawContent);
  const objects = [
    Buffer.from("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    Buffer.from("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
    Buffer.from(
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] " +
        "/Contents 4 0 R >>\nendobj\n",
    ),
    Buffer.concat([
      Buffer.from(
        `4 0 obj\n<< /Filter /FlateDecode /Length ${compressedContent.length} >>\nstream\n`,
      ),
      compressedContent,
      Buffer.from("\nendstream\nendobj\n"),
    ]),
  ];
  const header = Buffer.from("%PDF-1.7\n% compressed operator fixture\n");
  const offsets = [];
  let offset = header.length;
  for (const object of objects) {
    offsets.push(offset);
    offset += object.length;
  }
  const xref = Buffer.from(
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
      .map((entry) => `${String(entry).padStart(10, "0")} 00000 n `)
      .join("\n")}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
      `startxref\n${offset}\n%%EOF\n`,
  );
  return {
    data: new Uint8Array(Buffer.concat([header, ...objects, xref])),
    rawBytes: rawContent.length,
  };
}

function createFlateStreamSequenceFixture(decodedBytesPerStream, count) {
  const compressed = deflateSync(Buffer.alloc(decodedBytesPerStream, 0x20));
  const objects = Array.from({ length: count }, (_, index) =>
    Buffer.concat([
      Buffer.from(
        `${index + 1} 0 obj\n<< /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`,
      ),
      compressed,
      Buffer.from("\nendstream\nendobj\n"),
    ]),
  );
  return new Uint8Array(
    Buffer.concat([
      Buffer.from("%PDF-1.7\n"),
      ...objects,
      Buffer.from("%%EOF\n"),
    ]),
  );
}

function createManyIndirectLengthStreamsFixture(count, paddingBytes) {
  const compressed = deflateSync(Buffer.from("q Q\n"));
  const streams = Array.from({ length: count }, (_, index) => {
    const streamObject = index + 1;
    const lengthObject = count + index + 1;
    return Buffer.concat([
      Buffer.from(
        `${streamObject} 0 obj\n<< /Filter /FlateDecode /Length ${lengthObject} 0 R >>\nstream\n`,
      ),
      compressed,
      Buffer.from(
        `\nendstream\nendobj\n${lengthObject} 0 obj\n${compressed.length}\nendobj\n`,
      ),
    ]);
  });
  return new Uint8Array(
    Buffer.concat([
      Buffer.from("%PDF-1.7\n"),
      ...streams,
      Buffer.from(`%${"x".repeat(paddingBytes)}\n%%EOF\n`),
    ]),
  );
}

function createIncrementalIndirectLengthFixture(activeContent) {
  const obsoleteContent = deflateSync(Buffer.alloc(128, 0x20));
  const header = Buffer.from("%PDF-1.7\n");
  const obsoleteStream = Buffer.concat([
    Buffer.from("4 0 obj\n<< /Filter /FlateDecode /Length 9 0 R >>\nstream\n"),
    obsoleteContent,
    Buffer.from("\nendstream\nendobj\n"),
  ]);
  const oldLength = Buffer.from(`9 0 obj\n${obsoleteContent.length}\nendobj\n`);
  const obsoleteStreamOffset = header.length;
  const oldLengthOffset = obsoleteStreamOffset + obsoleteStream.length;
  const baseXrefOffset = oldLengthOffset + oldLength.length;
  const baseXref = Buffer.from(
    `xref\n0 1\n0000000000 65535 f \n4 1\n${String(obsoleteStreamOffset).padStart(10, "0")} 00000 n \n` +
      `9 1\n${String(oldLengthOffset).padStart(10, "0")} 00000 n \n` +
      `trailer\n<< /Size 10 >>\nstartxref\n${baseXrefOffset}\n%%EOF\n`,
  );
  const activeStreamOffset = baseXrefOffset + baseXref.length;
  const activeStream = Buffer.concat([
    Buffer.from("4 0 obj\n<< /Filter /FlateDecode /Length 9 0 R >>\nstream\n"),
    activeContent,
    Buffer.from("\nendstream\nendobj\n"),
  ]);
  const newLengthOffset = activeStreamOffset + activeStream.length;
  const newLength = Buffer.from(`9 0 obj\n${activeContent.length}\nendobj\n`);
  const updateXrefOffset = newLengthOffset + newLength.length;
  const updateXref = Buffer.from(
    `xref\n4 1\n${String(activeStreamOffset).padStart(10, "0")} 00000 n \n` +
      `9 1\n${String(newLengthOffset).padStart(10, "0")} 00000 n \n` +
      `trailer\n<< /Size 10 /Prev ${baseXrefOffset} >>\n` +
      `startxref\n${updateXrefOffset}\n%%EOF\n`,
  );
  return new Uint8Array(
    Buffer.concat([
      header,
      obsoleteStream,
      oldLength,
      baseXref,
      activeStream,
      newLength,
      updateXref,
    ]),
  );
}

function createXrefSelectedFilterFixture(decodedBytes) {
  const encodedContent = deflateSync(Buffer.alloc(decodedBytes, 0x20));
  const header = Buffer.from("%PDF-1.7\n");
  const streamObject = Buffer.concat([
    Buffer.from(
      `4 0 obj\n<< /Filter 8 0 R /Length ${encodedContent.length} >>\nstream\n`,
    ),
    encodedContent,
    Buffer.from("\nendstream\nendobj\n"),
  ]);
  const filterObject = Buffer.from("8 0 obj\n/FlateDecode\nendobj\n");
  const streamOffset = header.length;
  const filterOffset = streamOffset + streamObject.length;
  const xrefOffset = filterOffset + filterObject.length;
  const xref = Buffer.from(
    `xref\n0 1\n0000000000 65535 f \n4 1\n${String(streamOffset).padStart(10, "0")} 00000 n \n` +
      `8 1\n${String(filterOffset).padStart(10, "0")} 00000 n \n` +
      `trailer\n<< /Size 9 >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  );
  const unreferencedShadow = Buffer.from("8 0 obj\n/DCTDecode\nendobj\n");
  return new Uint8Array(
    Buffer.concat([
      header,
      streamObject,
      filterObject,
      xref,
      unreferencedShadow,
    ]),
  );
}

function createXrefParserFixture(entryTerminator, suffix = "") {
  const header = "%PDF-1.7\n";
  return new TextEncoder().encode(
    `${header}xref\n1 1\n0000000000 00000 n${entryTerminator}` +
      `trailer\n<< /Size 2 >>\nstartxref\n${header.length}\n%%EOF\n${suffix}`,
  );
}

function createShiftedFreeEntryIncrementalFixture() {
  const encodedContent = deflateSync(Buffer.alloc(128, 0x20));
  const header = Buffer.from("%PDF-1.7\n");
  const streamObject = Buffer.concat([
    Buffer.from(
      `2 0 obj\n<< /Filter /FlateDecode /Length ${encodedContent.length} >>\nstream\n`,
    ),
    encodedContent,
    Buffer.from("\nendstream\nendobj\n"),
  ]);
  const streamOffset = header.length;
  const baseXrefOffset = streamOffset + streamObject.length;
  const baseXref = Buffer.from(
    `xref\n2 1\n${String(streamOffset).padStart(10, "0")} 00000 n \n` +
      `trailer\n<< /Size 3 >>\nstartxref\n${baseXrefOffset}\n%%EOF\n`,
  );
  const objectOneOffset = baseXrefOffset + baseXref.length;
  const objectOne = Buffer.from("1 0 obj\nnull\nendobj\n");
  const updateXrefOffset = objectOneOffset + objectOne.length;
  const updateXref = Buffer.from(
    "xref\n1 2\n0000000000 65535 f \n" +
      `${String(objectOneOffset).padStart(10, "0")} 00000 n \n` +
      `trailer\n<< /Size 3 /Prev ${baseXrefOffset} >>\n` +
      `startxref\n${updateXrefOffset}\n%%EOF\n`,
  );
  return new Uint8Array(
    Buffer.concat([header, streamObject, baseXref, objectOne, updateXref]),
  );
}

function encodeAscii85(data) {
  const output = [];
  for (let offset = 0; offset < data.length; offset += 4) {
    const remaining = Math.min(4, data.length - offset);
    let value = 0;
    for (let index = 0; index < 4; index += 1) {
      value = value * 256 + (data[offset + index] ?? 0);
    }
    if (remaining === 4 && value === 0) {
      output.push("z");
      continue;
    }
    const encoded = Array(5);
    for (let index = 4; index >= 0; index -= 1) {
      encoded[index] = String.fromCharCode((value % 85) + 33);
      value = Math.floor(value / 85);
    }
    output.push(encoded.slice(0, remaining + 1).join(""));
  }
  return Buffer.from(`${output.join("")}~>`);
}

function encodeLiteralLzw(data) {
  const codes = [256, ...data, 257];
  const output = [];
  let bits = 0;
  let bitCount = 0;
  for (const code of codes) {
    bits = bits * 512 + code;
    bitCount += 9;
    while (bitCount >= 8) {
      bitCount -= 8;
      output.push(Math.floor(bits / 2 ** bitCount) & 0xff);
      bits %= 2 ** bitCount;
    }
  }
  if (bitCount > 0) output.push((bits * 2 ** (8 - bitCount)) & 0xff);
  return Buffer.from(output);
}

function encodeShortDictionaryLzw(data) {
  const dictionary = new Map(
    Array.from({ length: 256 }, (_, index) => [
      String.fromCharCode(index),
      index,
    ]),
  );
  const codes = [256];
  let nextCode = 258;
  let phrase = "";
  for (const byte of data) {
    const character = String.fromCharCode(byte);
    const combined = phrase + character;
    if (dictionary.has(combined)) {
      phrase = combined;
      continue;
    }
    codes.push(dictionary.get(phrase));
    dictionary.set(combined, nextCode);
    nextCode += 1;
    phrase = character;
  }
  if (phrase) codes.push(dictionary.get(phrase));
  codes.push(257);
  assert.ok(codes.some((code) => code >= 258));
  assert.ok(nextCode < 512);

  const output = [];
  let bits = 0;
  let bitCount = 0;
  for (const code of codes) {
    bits = bits * 512 + code;
    bitCount += 9;
    while (bitCount >= 8) {
      bitCount -= 8;
      output.push(Math.floor(bits / 2 ** bitCount) & 0xff);
      bits %= 2 ** bitCount;
    }
  }
  if (bitCount > 0) output.push((bits * 2 ** (8 - bitCount)) & 0xff);
  return Buffer.from(output);
}

function encodeTransitioningLiteralLzw(
  literalCount,
  earlyChange,
  resetAfter = null,
) {
  const codes = [256];
  for (let index = 0; index < literalCount; index += 1) {
    if (index === resetAfter) codes.push(256);
    codes.push(0x20);
  }
  codes.push(257);

  const output = [];
  let bits = 0;
  let bitCount = 0;
  let codeLength = 9;
  let nextCode = 258;
  let hasPreviousCode = false;
  for (const code of codes) {
    bits = bits * 2 ** codeLength + code;
    bitCount += codeLength;
    while (bitCount >= 8) {
      bitCount -= 8;
      output.push(Math.floor(bits / 2 ** bitCount) & 0xff);
      bits %= 2 ** bitCount;
    }
    if (code === 256) {
      codeLength = 9;
      nextCode = 258;
      hasPreviousCode = false;
    } else if (code !== 257) {
      if (hasPreviousCode && nextCode < 4096) {
        nextCode += 1;
        if (codeLength < 12 && nextCode + earlyChange === 2 ** codeLength) {
          codeLength += 1;
        }
      }
      hasPreviousCode = true;
    }
  }
  if (bitCount > 0) output.push((bits * 2 ** (8 - bitCount)) & 0xff);
  return Buffer.from(output);
}

function encodeRunLengthLiteral(data) {
  const output = [];
  for (let offset = 0; offset < data.length; offset += 128) {
    const chunk = data.subarray(offset, offset + 128);
    output.push(chunk.length - 1, ...chunk);
  }
  output.push(128);
  return Buffer.from(output);
}

function createFilteredOperatorPdfFixture({
  decodeParms = "",
  encodedContent,
  filter,
  filterWhitespace = " ",
  indirectLength = false,
}) {
  const lengthValue = indirectLength ? "9 0 R" : String(encodedContent.length);
  const objects = [
    Buffer.from("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    Buffer.from("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
    Buffer.from(
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] " +
        "/Contents 4 0 R >>\nendobj\n",
    ),
    Buffer.concat([
      Buffer.from(
        `4 0 obj\n<< /Filter${filterWhitespace}${filter}${decodeParms} /Length ${lengthValue} >>\nstream\n`,
      ),
      encodedContent,
      Buffer.from("\nendstream\nendobj\n"),
    ]),
  ];
  if (indirectLength) {
    objects.push(Buffer.from(`9 0 obj\n${encodedContent.length}\nendobj\n`));
  }
  const header = Buffer.from("%PDF-1.7\n% filtered operator fixture\n");
  const objectNumbers = indirectLength ? [1, 2, 3, 4, 9] : [1, 2, 3, 4];
  const offsets = [];
  let offset = header.length;
  for (const object of objects) {
    offsets.push(offset);
    offset += object.length;
  }
  const offsetByObject = new Map(
    objectNumbers.map((objectNumber, index) => [objectNumber, offsets[index]]),
  );
  const xref = Buffer.from(
    `xref\n0 10\n0000000000 65535 f \n${Array.from(
      { length: 9 },
      (_, index) => index + 1,
    )
      .map((objectNumber) =>
        offsetByObject.has(objectNumber)
          ? `${String(offsetByObject.get(objectNumber)).padStart(10, "0")} 00000 n `
          : "0000000000 65535 f ",
      )
      .join("\n")}\ntrailer\n<< /Size 10 /Root 1 0 R >>\n` +
      `startxref\n${offset}\n%%EOF\n`,
  );
  return new Uint8Array(Buffer.concat([header, ...objects, xref]));
}

function createViewOnlyAnnotationPdfFixture() {
  const appearance = Buffer.from("q 1 0 0 RG 0 0 100 100 re S Q\n");
  const objects = [
    Buffer.from("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    Buffer.from("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
    Buffer.from(
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] " +
        "/Annots [4 0 R] >>\nendobj\n",
    ),
    Buffer.from(
      "4 0 obj\n<< /Type /Annot /Subtype /Square /Rect [50 50 150 150] " +
        "/F 0 /AP << /N 5 0 R >> >>\nendobj\n",
    ),
    Buffer.concat([
      Buffer.from(
        `5 0 obj\n<< /Type /XObject /Subtype /Form /BBox [0 0 100 100] /Length ${appearance.length} >>\nstream\n`,
      ),
      appearance,
      Buffer.from("endstream\nendobj\n"),
    ]),
  ];
  const header = Buffer.from("%PDF-1.7\n% view annotation fixture\n");
  const offsets = [];
  let offset = header.length;
  for (const object of objects) {
    offsets.push(offset);
    offset += object.length;
  }
  const xref = Buffer.from(
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
      .map((entry) => `${String(entry).padStart(10, "0")} 00000 n `)
      .join("\n")}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
      `startxref\n${offset}\n%%EOF\n`,
  );
  return new Uint8Array(Buffer.concat([header, ...objects, xref]));
}

function createNoopCanvasContext() {
  const transform = {
    a: 1,
    b: 0,
    c: 0,
    d: 1,
    e: 0,
    f: 0,
    invertSelf() {
      return this;
    },
  };
  return new Proxy(
    {
      canvas: { height: 1, width: 1 },
      getTransform: () => transform,
      measureText: () => ({ width: 0 }),
    },
    {
      get(target, property) {
        if (property in target) return target[property];
        return () => {};
      },
      set(target, property, value) {
        target[property] = value;
        return true;
      },
    },
  );
}

async function renderPdfWithOperatorBudget(data, stopAtErrors) {
  const options = stopAtErrors
    ? createPdfDocumentOptions(data.slice())
    : createPdfDocumentProbeOptions(data.slice());
  const loadingTask = pdfjs.getDocument({
    ...options,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  });
  try {
    const document = await loadingTask.promise;
    const page = await document.getPage(1);
    const budget = createPdfOperatorBudget({ executeOperations: false });
    const renderTask = page.render({
      canvas: null,
      canvasContext: createNoopCanvasContext(),
      intent: "print",
      operationsFilter: budget.operationsFilter,
      viewport: page.getViewport({ scale: 1 }),
    });
    await assert.rejects(renderTask.promise, /operation limit/);
    return budget.consumedOperations();
  } finally {
    await loadingTask.destroy();
  }
}

async function readPdfRenderOperationCount(data, stopAtErrors) {
  const options = stopAtErrors
    ? createPdfDocumentOptions(data.slice())
    : createPdfDocumentProbeOptions(data.slice());
  const loadingTask = pdfjs.getDocument({
    ...options,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  });
  try {
    const document = await loadingTask.promise;
    const page = await document.getPage(1);
    const budget = createPdfOperatorBudget({ executeOperations: false });
    const renderTask = page.render({
      canvas: null,
      canvasContext: createNoopCanvasContext(),
      intent: "print",
      operationsFilter: budget.operationsFilter,
      viewport: page.getViewport({ scale: 1 }),
    });
    await renderTask.promise;
    return budget.consumedOperations();
  } finally {
    await loadingTask.destroy();
  }
}

async function readPdfOperatorList(data, stopAtErrors) {
  const options = stopAtErrors
    ? createPdfDocumentOptions(data.slice())
    : createPdfDocumentProbeOptions(data.slice());
  const loadingTask = pdfjs.getDocument({
    ...options,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  });
  try {
    const document = await loadingTask.promise;
    const page = await document.getPage(1);
    return await page.getOperatorList();
  } finally {
    await loadingTask.destroy();
  }
}

async function readPdfOperatorListForIntent(data, intent) {
  const loadingTask = pdfjs.getDocument({
    ...createPdfDocumentOptions(data.slice()),
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  });
  try {
    const document = await loadingTask.promise;
    const page = await document.getPage(1);
    return await page.getOperatorList({ intent });
  } finally {
    await loadingTask.destroy();
  }
}

function createPage(pageNumber, options = {}) {
  const renderDeferred = options.renderDeferred ?? null;
  const calls = {
    cancel: 0,
    cleanup: 0,
    itemBudgets: [],
    render: 0,
    textAbort: 0,
    textRequests: 0,
    viewportScales: [],
  };
  return {
    calls,
    page: {
      cleanup() {
        calls.cleanup += 1;
        return true;
      },
      async getTextContent({ maxCharacters, maxItems, signal }) {
        calls.textRequests += 1;
        calls.itemBudgets.push(maxItems);
        if (options.textError) throw options.textError;
        const textDeferred =
          options.textDeferredFactory?.() ?? options.textDeferred;
        if (textDeferred) {
          await new Promise((resolve, reject) => {
            const abort = () => {
              calls.textAbort += 1;
              const cause = new Error("aborted");
              cause.name = "AbortError";
              reject(cause);
            };
            signal.addEventListener("abort", abort, { once: true });
            textDeferred.promise.then((value) => {
              signal.removeEventListener("abort", abort);
              resolve(value);
            }, reject);
          });
        }
        const fullText = options.text ?? `Text from page ${pageNumber}`;
        const hasItemBudget = maxItems > 0;
        const requestedItems = options.consumedItems ?? 1;
        const consumedCharacters = hasItemBudget ? fullText.length : 0;
        return {
          consumedCharacters,
          consumedItems: hasItemBudget ? Math.min(requestedItems, maxItems) : 0,
          items: hasItemBudget
            ? [{ str: fullText.slice(0, maxCharacters) }]
            : [],
          truncated:
            fullText.length > maxCharacters ||
            requestedItems > maxItems ||
            maxItems < 1,
        };
      },
      getViewport({ scale }) {
        calls.viewportScales.push(scale);
        return {
          height: (options.height ?? 792) * scale,
          width: (options.width ?? 612) * scale,
        };
      },
      render() {
        calls.render += 1;
        return {
          cancel() {
            calls.cancel += 1;
            if (renderDeferred) {
              const cancelled = new Error("cancelled");
              cancelled.name = "RenderingCancelledException";
              renderDeferred.reject(cancelled);
            }
          },
          promise: renderDeferred?.promise ?? Promise.resolve(),
        };
      },
    },
  };
}

function createDocument(numPages, createPageForNumber = createPage) {
  const pages = [];
  return {
    document: {
      async getPage(pageNumber) {
        const record = createPageForNumber(pageNumber);
        pages.push(record);
        return record.page;
      },
      numPages,
    },
    pages,
  };
}

function createRuntime(loadResults, options = {}) {
  const calls = { destroy: 0, load: 0 };
  return {
    calls,
    runtime: {
      isCancelledRender(cause) {
        return (
          cause instanceof Error && cause.name === "RenderingCancelledException"
        );
      },
      loadDocument() {
        const result =
          loadResults[Math.min(calls.load, loadResults.length - 1)];
        calls.load += 1;
        return {
          async destroy() {
            calls.destroy += 1;
            if (options.destroyDeferred) {
              await options.destroyDeferred.promise;
            }
          },
          promise: result,
        };
      },
    },
  };
}

async function renderViewer(runtime, onRetry = () => {}) {
  const { createElement } = await import("react");
  const { act, render } = await import("@testing-library/react");
  const { PdfWorkspaceViewerView } = await import(
    "./PdfWorkspaceViewerView.tsx"
  );
  const view = render(
    createElement(PdfWorkspaceViewerView, {
      bytesBase64: globalThis.btoa("%PDF-1.4"),
      name: "report.pdf",
      onRetry,
      runtime,
    }),
  );
  await act(async () => {});
  return view;
}

async function setAllPagesVisible(isVisible) {
  const { act } = await import("@testing-library/react");
  await act(async () => {
    for (const observer of MockIntersectionObserver.instances) {
      observer.setVisible(isVisible);
    }
  });
}

async function setPageVisible(index, isVisible) {
  const { act } = await import("@testing-library/react");
  await act(async () => {
    MockIntersectionObserver.instances[index]?.setVisible(isVisible);
  });
}

test("PDF model bounds scale, bytes, text, and canvas pixels", () => {
  assert.equal(clampPdfScale(0.2), 0.5);
  assert.equal(clampPdfScale(1.25), 1.25);
  assert.equal(clampPdfScale(4), 2.5);
  assert.equal(
    new TextDecoder().decode(decodePdfBytes(globalThis.btoa("%PDF-1.4"))),
    "%PDF-1.4",
  );
  assert.equal(
    extractPdfPageText([{ str: "First" }, {}, { str: "Second" }]),
    "First Second",
  );

  const metrics = calculatePdfCanvasMetrics(1530, 1980, 2);
  assert.ok(metrics.pixelWidth * metrics.pixelHeight <= MAX_PDF_CANVAS_PIXELS);
  assert.equal(metrics.cssWidth, 1530);
  assert.equal(metrics.cssHeight, 1980);
  assert.equal(MAX_PDF_WORKSPACE_PAGES, 500);
});

test("PDF.js options cap oversized image dictionaries and canvas decoding", () => {
  const data = decodePdfBytes(globalThis.btoa("%PDF-1.4"));
  const options = createPdfDocumentOptions(data);
  const probeOptions = createPdfDocumentProbeOptions(data);
  assert.equal(options.data, data);
  assert.equal(options.maxImageSize, MAX_PDF_IMAGE_PIXELS);
  assert.equal(options.canvasMaxAreaInBytes, MAX_PDF_CANVAS_AREA_BYTES);
  assert.equal(options.maxImageSize, 16_000_000);
  assert.equal(options.canvasMaxAreaInBytes, 64 * 1_024 * 1_024);
  assert.equal(options.stopAtErrors, true);
  assert.equal(probeOptions.maxImageSize, MAX_PDF_IMAGE_PIXELS);
  assert.equal(probeOptions.canvasMaxAreaInBytes, MAX_PDF_CANVAS_AREA_BYTES);
  assert.equal(probeOptions.stopAtErrors, false);
});

test("compressed operator floods fail within the strict and tolerant work budget", async () => {
  const fixture = createCompressedOperatorFloodPdfFixture();
  assert.ok(fixture.rawBytes >= 4_000_000);
  assert.ok(fixture.data.byteLength < 20_000);
  await assert.doesNotReject(assertPdfDecodedStreamBudget(fixture.data));

  for (const stopAtErrors of [true, false]) {
    const consumed = await renderPdfWithOperatorBudget(
      fixture.data,
      stopAtErrors,
    );
    assert.equal(consumed, MAX_PDF_OPERATOR_WORK_PER_PAGE + 1);
  }
});

test("Flate preflight rejects a realistic compression bomb while retaining only streamed chunks", async () => {
  const fixture = createCompressedOperatorFloodPdfFixture(16_000_000);
  assert.ok(fixture.rawBytes >= 64_000_000);
  assert.ok(fixture.data.byteLength < 100_000);
  assert.equal(MAX_PDF_DECODED_STREAM_BYTES, 16 * 1_024 * 1_024);
  assert.equal(MAX_PDF_DECODED_TOTAL_BYTES, 64 * 1_024 * 1_024);

  await assert.rejects(assertPdfDecodedStreamBudget(fixture.data), (cause) => {
    assert.match(cause.message, /decoded stream limit/);
    assert.ok(cause.decodedBytes > MAX_PDF_DECODED_STREAM_BYTES);
    assert.ok(cause.largestChunkBytes < 1_024 * 1_024);
    assert.ok(cause.largestChunkBytes < fixture.rawBytes / 64);
    return true;
  });
});

test("Flate preflight enforces the decoded document ceiling across safe-sized streams", async () => {
  const fixture = createFlateStreamSequenceFixture(15 * 1_024 * 1_024, 5);
  assert.ok(fixture.byteLength < 100_000);

  await assert.rejects(assertPdfDecodedStreamBudget(fixture), (cause) => {
    assert.match(cause.message, /decoded document limit/);
    assert.ok(cause.decodedBytes > MAX_PDF_DECODED_TOTAL_BYTES);
    assert.ok(cause.largestChunkBytes < 1_024 * 1_024);
    return true;
  });
});

test("preflight parses legal comments and indirect stream lengths without a filter bypass", async () => {
  const rawContent = Buffer.from("q Q\n");
  const compressedRawContent = deflateSync(rawContent);
  const safe = createFilteredOperatorPdfFixture({
    encodedContent: compressedRawContent,
    filter: "/FlateDecode",
    filterWhitespace: "% legal PDF comment\n  ",
    indirectLength: true,
  });
  await assert.doesNotReject(assertPdfDecodedStreamBudget(safe));
  assert.ok((await readPdfRenderOperationCount(safe, true)) > 0);

  const incrementalLength =
    createIncrementalIndirectLengthFixture(compressedRawContent);
  await assert.doesNotReject(
    assertPdfDecodedStreamBudget(incrementalLength, { maxStreamBytes: 64 }),
  );

  const manyLengths = createManyIndirectLengthStreamsFixture(64, 5_000_000);
  await assert.doesNotReject(assertPdfDecodedStreamBudget(manyLengths));

  const bomb = createFilteredOperatorPdfFixture({
    encodedContent: deflateSync(Buffer.alloc(128, 0x20)),
    filter: "/FlateDecode",
    filterWhitespace: "% legal PDF comment\r\n  ",
  });
  await assert.rejects(
    assertPdfDecodedStreamBudget(bomb, { maxStreamBytes: 64 }),
    /decoded stream limit/,
  );
});

test("preflight resolves indirect filters and decode parameters", async () => {
  const encodedContent = deflateSync(Buffer.from([0, 0x71, 0x20, 0x51]));
  const fixture = new Uint8Array(
    Buffer.concat([
      Buffer.from(
        `%PDF-1.7\n4 0 obj\n<< /Filter 8 0 R /DecodeParms 7 0 R /Length ${encodedContent.length} >>\nstream\n`,
      ),
      encodedContent,
      Buffer.from(
        "\nendstream\nendobj\n" +
          "7 0 obj\n<< /Predictor 12 /Columns 11 0 R /Colors 1 /BitsPerComponent 8 >>\nendobj\n" +
          "8 0 obj\n/FlateDecode\nendobj\n" +
          "11 0 obj\n3\nendobj\n%%EOF\n",
      ),
    ]),
  );

  await assert.doesNotReject(
    assertPdfDecodedStreamBudget(fixture, { maxStreamBytes: 64 }),
  );

  await assert.rejects(
    assertPdfDecodedStreamBudget(createXrefSelectedFilterFixture(128), {
      maxStreamBytes: 64,
    }),
    /decoded stream limit/,
  );
});

test("xref parsing aligns malformed subsections and fails closed", async () => {
  assert.equal(
    readActivePdfXrefOffsets(createXrefParserFixture("trailer")),
    null,
  );
  assert.equal(
    readActivePdfXrefOffsets(
      createXrefParserFixture(" \n", "startxref\n999999\n%%EOF\n"),
    ),
    null,
  );
  await assert.rejects(
    assertPdfDecodedStreamBudget(createShiftedFreeEntryIncrementalFixture(), {
      maxStreamBytes: 64,
    }),
    /decoded stream limit/,
  );
});

test("preflight safely supports ASCII85 plus Flate and LZW content streams", async () => {
  const rawContent = Buffer.from("q Q\n");
  const ascii85Flate = createFilteredOperatorPdfFixture({
    encodedContent: encodeAscii85(deflateSync(rawContent)),
    filter: "[/ASCII85Decode /FlateDecode]",
  });
  const lzw = createFilteredOperatorPdfFixture({
    encodedContent: encodeShortDictionaryLzw(
      Buffer.from("q q q q q q q q q q q q Q\n"),
    ),
    filter: "/LZWDecode",
  });
  const runLength = createFilteredOperatorPdfFixture({
    encodedContent: encodeRunLengthLiteral(rawContent),
    filter: "/RunLengthDecode",
  });

  for (const fixture of [ascii85Flate, lzw, runLength]) {
    await assert.doesNotReject(assertPdfDecodedStreamBudget(fixture));
    assert.ok((await readPdfRenderOperationCount(fixture, true)) > 0);
  }

  await assert.doesNotReject(
    assertPdfDecodedStreamBudget(ascii85Flate, {
      maxDocumentBytes: 8,
      maxStreamBytes: 8,
    }),
  );

  const lzwBomb = createFilteredOperatorPdfFixture({
    encodedContent: encodeLiteralLzw(Buffer.alloc(128, 0x20)),
    filter: "/LZWDecode",
  });
  await assert.rejects(
    assertPdfDecodedStreamBudget(lzwBomb, { maxStreamBytes: 64 }),
    /decoded stream limit/,
  );

  const runLengthBomb = createFilteredOperatorPdfFixture({
    encodedContent: Buffer.from([129, 0x20, 128]),
    filter: "/RunLengthDecode",
  });
  await assert.rejects(
    assertPdfDecodedStreamBudget(runLengthBomb, { maxStreamBytes: 64 }),
    /decoded stream limit/,
  );
});

test("LZW preflight crosses code widths for both EarlyChange modes and resets", async () => {
  for (const earlyChange of [0, 1]) {
    for (const resetAfter of [null, 3_900]) {
      const decodedBytes = 5_000;
      const fixture = createFilteredOperatorPdfFixture({
        decodeParms: ` /DecodeParms << /EarlyChange ${earlyChange} >>`,
        encodedContent: encodeTransitioningLiteralLzw(
          decodedBytes,
          earlyChange,
          resetAfter,
        ),
        filter: "/LZWDecode",
      });
      await assert.doesNotReject(
        assertPdfDecodedStreamBudget(fixture, {
          maxStreamBytes: decodedBytes,
        }),
      );
      await assert.rejects(
        assertPdfDecodedStreamBudget(fixture, {
          maxStreamBytes: decodedBytes - 1,
        }),
        /decoded stream limit/,
      );
    }
  }
});

test("preflight rejects predictor rows that exceed the decoded stream", async () => {
  const hostile = createFilteredOperatorPdfFixture({
    decodeParms:
      " /DecodeParms << /Predictor 12 /Columns 1000000 /Colors 3 /BitsPerComponent 8 >>",
    encodedContent: deflateSync(Buffer.from([0, 0])),
    filter: "/FlateDecode",
  });
  await assert.rejects(
    assertPdfDecodedStreamBudget(hostile, { maxStreamBytes: 64 }),
    /PDF predictor row exceeds decoded stream limit/,
  );

  await assert.rejects(
    assertPdfDecodedStreamBudget(hostile, {
      maxStreamBytes: 4 * 1_024 * 1_024,
    }),
    /PDF predictor row exceeds decoded stream data/,
  );

  const safe = createFilteredOperatorPdfFixture({
    decodeParms:
      " /DecodeParms << /Predictor 12 /Columns 3 /Colors 1 /BitsPerComponent 8 >>",
    encodedContent: deflateSync(Buffer.from([0, 0x71, 0x20, 0x51])),
    filter: "/FlateDecode",
  });
  await assert.doesNotReject(
    assertPdfDecodedStreamBudget(safe, { maxStreamBytes: 64 }),
  );
});

test("preflight accepts a flat page tree up to the viewer page limit", async () => {
  const fixture = createFlatPageTreePdfFixture(MAX_PDF_WORKSPACE_PAGES);
  await assert.doesNotReject(assertPdfDecodedStreamBudget(fixture));
  const loadingTask = pdfjs.getDocument({ data: fixture });
  const document = await loadingTask.promise;
  try {
    assert.equal(document.numPages, MAX_PDF_WORKSPACE_PAGES);
  } finally {
    await loadingTask.destroy();
  }
});

test("preflight fails closed on malformed chains, references, predictors, and lengths", async () => {
  const unsupported = new TextEncoder().encode(
    "%PDF-1.7\n1 0 obj\n<< /Filter [/FlateDecode /ASCII85Decode] /Length 4 >>\nstream\nzzzz\nendstream\nendobj\n%%EOF",
  );
  await assert.rejects(
    assertPdfDecodedStreamBudget(unsupported),
    /unsupported PDF stream filter chain/,
  );

  const cyclicLength = new TextEncoder().encode(
    "%PDF-1.7\n1 0 obj\n<< /Filter /FlateDecode /Length 9 0 R >>\nstream\nx\nendstream\nendobj\n9 0 obj\n9 0 R\nendobj\n%%EOF",
  );
  await assert.rejects(
    assertPdfDecodedStreamBudget(cyclicLength),
    /PDF stream length is invalid/,
  );

  const hiddenLength = new TextEncoder().encode(
    "%PDF-1.7\n1 0 obj\n<< /Length 9 0 R >>\nstream\nx\nendstream\nendobj\n" +
      "9 0 obj\n1\nendobj\n10 0 obj\n(9 0 obj 2 endobj)\nendobj\n%%EOF",
  );
  await assert.rejects(
    assertPdfDecodedStreamBudget(hiddenLength),
    /PDF stream length is invalid/,
  );

  const unknownPredictor = createFilteredOperatorPdfFixture({
    decodeParms: " /DecodeParms << /Predictor 99 >>",
    encodedContent: deflateSync(Buffer.from("q Q\n")),
    filter: "/FlateDecode",
  });
  await assert.rejects(
    assertPdfDecodedStreamBudget(unknownPredictor),
    /unsupported PDF predictor/,
  );

  const malformed = new TextEncoder().encode(
    "%PDF-1.7\n1 0 obj\n<< /Filter /FlateDecode /Length 999 >>\nstream\nx\nendstream\nendobj\n%%EOF",
  );
  await assert.rejects(
    assertPdfDecodedStreamBudget(malformed),
    /PDF stream length is invalid/,
  );

  const unfiltered = new TextEncoder().encode(
    "%PDF-1.7\n1 0 obj\n<< /Length 8 >>\nstream\nq q q q \nendstream\nendobj\n%%EOF",
  );
  await assert.rejects(
    assertPdfDecodedStreamBudget(unfiltered, { maxStreamBytes: 4 }),
    /decoded stream limit/,
  );

  const unsupportedFilter = new TextEncoder().encode(
    "%PDF-1.7\n1 0 obj\n<< /Filter /Crypt /Length 1 >>\nstream\nx\nendstream\nendobj\n%%EOF",
  );
  await assert.rejects(
    assertPdfDecodedStreamBudget(unsupportedFilter),
    /unsupported PDF stream filter/,
  );
});

test("display intent preserves view-only annotations that print omits", async () => {
  const fixture = createViewOnlyAnnotationPdfFixture();
  const display = await readPdfOperatorListForIntent(
    fixture,
    PDF_WORKSPACE_RENDER_INTENT,
  );
  const print = await readPdfOperatorListForIntent(fixture, "print");

  assert.ok(display.fnArray.includes(pdfjs.OPS.beginAnnotation));
  assert.equal(print.fnArray.includes(pdfjs.OPS.beginAnnotation), false);
});

test("renders a real blank page and rejects an image above the hard cap", async () => {
  const blank = createBlankPdfFixture();
  const blankStrict = await readPdfOperatorList(blank, true);
  const blankProbe = await readPdfOperatorList(blank, false);
  assert.deepEqual(blankStrict.fnArray, []);
  assert.deepEqual(blankProbe.fnArray, []);
  assert.doesNotThrow(() =>
    assertPdfPageHasRenderableContent(blankStrict.fnArray, blankProbe.fnArray),
  );
  assert.equal(await readPdfRenderOperationCount(blank, true), 0);
  assert.equal(await readPdfRenderOperationCount(blank, false), 0);

  const a4ScanFixture = createScannedPdfFixture(2480, 3508);
  const a4Scan = await readPdfOperatorList(a4ScanFixture, true);
  assert.ok(a4Scan.fnArray.includes(pdfjs.OPS.paintImageXObject));
  assert.ok(
    (await readPdfRenderOperationCount(a4ScanFixture, true)) <
      MAX_PDF_OPERATOR_WORK_PER_PAGE,
  );
  assert.doesNotThrow(() =>
    assertPdfPageHasRenderableContent(a4Scan.fnArray, a4Scan.fnArray),
  );

  const oversizedFixture = createScannedPdfFixture(4001, 4000);
  const oversized = await readPdfOperatorList(oversizedFixture, true);
  const oversizedProbe = await readPdfOperatorList(oversizedFixture, false);
  assert.deepEqual(oversized.fnArray, []);
  assert.ok(oversizedProbe.fnArray.length > 0);
  assert.equal(
    oversizedProbe.fnArray.includes(pdfjs.OPS.paintImageXObject),
    false,
  );
  assert.throws(
    () =>
      assertPdfPageHasRenderableContent(
        oversized.fnArray,
        oversizedProbe.fnArray,
      ),
    /content was rejected/,
  );
  assert.equal(await readPdfRenderOperationCount(oversizedFixture, true), 0);
  assert.ok((await readPdfRenderOperationCount(oversizedFixture, false)) > 0);
});

test("PDF canvas metrics stay finite and hard-capped for hostile geometry", () => {
  assert.equal(hasValidPdfViewportDimensions(612, 792), true);
  for (const [width, height] of [
    [Number.NaN, 792],
    [612, Number.POSITIVE_INFINITY],
    [0, 792],
    [612, -1],
  ]) {
    assert.equal(hasValidPdfViewportDimensions(width, height), false);
  }

  const cases = [
    [1e9, 1, 2],
    [1, 1e9, 2],
    [Number.MAX_VALUE, Number.MIN_VALUE, Number.POSITIVE_INFINITY],
    [Number.NaN, Number.NEGATIVE_INFINITY, Number.NaN],
    [0, -10, -2],
  ];

  for (const [width, height, ratio] of cases) {
    const metrics = calculatePdfCanvasMetrics(width, height, ratio);
    assert.equal(
      Object.values(metrics).every(
        (value) => Number.isFinite(value) && value > 0,
      ),
      true,
    );
    assert.ok(metrics.cssWidth <= MAX_PDF_CSS_DIMENSION);
    assert.ok(metrics.cssHeight <= MAX_PDF_CSS_DIMENSION);
    assert.ok(metrics.pixelWidth <= MAX_PDF_CANVAS_DIMENSION);
    assert.ok(metrics.pixelHeight <= MAX_PDF_CANVAS_DIMENSION);
    assert.ok(
      metrics.pixelWidth * metrics.pixelHeight <= MAX_PDF_CANVAS_PIXELS,
    );
    assert.ok(metrics.pageScaleMultiplier <= 1);
  }

  const tinyBudget = calculatePdfCanvasMetrics(1e9, 1, 2, 17);
  assert.ok(tinyBudget.pixelWidth * tinyBudget.pixelHeight <= 17);
  const boundedText = extractPdfPageTextWithinBudget([{ str: "123456789" }], 5);
  assert.deepEqual(boundedText, { text: "12345", truncated: true });
});

test("text budgets charge raw characters and every item", () => {
  const result = consumePdfTextItemsWithinBudget(
    [
      { str: "  raw  " },
      { str: "" },
      { type: "beginMarkedContent" },
      { str: "tail" },
    ],
    20,
    3,
  );

  assert.deepEqual(result, {
    consumedCharacters: 7,
    consumedItems: 3,
    items: [{ str: "  raw  " }, { str: "" }],
    retainedCharacters: 7,
    truncated: true,
  });
  assert.deepEqual(consumePdfTextItemsWithinBudget([{ str: "   x" }], 2, 1), {
    consumedCharacters: 4,
    consumedItems: 1,
    items: [{ str: "  " }],
    retainedCharacters: 2,
    truncated: true,
  });
  assert.equal(MAX_PDF_TEXT_ITEMS_PER_PAGE, 50_000);
  assert.equal(MAX_PDF_TEXT_ITEMS_TOTAL, 500_000);
});

test("renders only visible pages and exposes extracted text", async () => {
  const pdf = createDocument(3);
  const { runtime } = createRuntime([Promise.resolve(pdf.document)]);
  await renderViewer(runtime);
  const { screen, waitFor } = await import("@testing-library/react");

  assert.equal(
    (await screen.findAllByLabelText(/report\.pdf, page/)).length,
    3,
  );
  assert.equal(pdf.pages.length, 0);
  assert.match(
    screen.getByTestId("workspace-pdf-text-3").textContent,
    /loads when visible/,
  );
  assert.match(screen.getByRole("status").textContent, /3 pages/);

  await setAllPagesVisible(true);
  await waitFor(() =>
    assert.equal(
      pdf.pages.filter((record) => record.calls.render === 1).length,
      3,
    ),
  );
  await screen.findByText("Text from page 3");
  assert.equal(screen.getAllByTestId(/workspace-pdf-text-/).length, 3);
  assert.deepEqual(
    screen
      .getAllByTestId(/workspace-pdf-text-/)
      .map((node) => node.textContent),
    ["Text from page 1", "Text from page 2", "Text from page 3"],
  );
  assert.equal(
    pdf.pages.filter((record) => record.calls.render === 1).length,
    3,
  );
});

test("accessible text runs one visible page at a time and aborts offscreen work", async () => {
  const firstText = deferred();
  const pdf = createDocument(3, (pageNumber) =>
    createPage(pageNumber, {
      textDeferred: pageNumber === 1 ? firstText : undefined,
    }),
  );
  const { runtime } = createRuntime([Promise.resolve(pdf.document)]);
  await renderViewer(runtime);
  const { waitFor } = await import("@testing-library/react");

  assert.equal(pdf.pages.length, 0);
  await setAllPagesVisible(true);
  await waitFor(() =>
    assert.equal(
      pdf.pages.filter((record) => record.calls.textRequests === 1).length,
      1,
    ),
  );
  await setPageVisible(0, false);
  await waitFor(() =>
    assert.equal(
      pdf.pages.filter((record) => record.calls.textAbort === 1).length,
      1,
    ),
  );
  await waitFor(() =>
    assert.equal(
      pdf.pages.filter((record) => record.calls.textRequests === 1).length,
      3,
    ),
  );
  assert.equal(
    pdf.pages.filter((record) => record.calls.textRequests === 1)[0].calls
      .textAbort,
    1,
  );
});

test("accessible text refunds repeated offscreen aborts before committing budget", async () => {
  const abortCount = MAX_PDF_TEXT_CHARS_TOTAL / MAX_PDF_TEXT_CHARS_PER_PAGE + 2;
  let requests = 0;
  const pdf = createDocument(1, (pageNumber) =>
    createPage(pageNumber, {
      textDeferredFactory() {
        requests += 1;
        return requests <= abortCount ? deferred() : undefined;
      },
    }),
  );
  const { runtime } = createRuntime([Promise.resolve(pdf.document)]);
  await renderViewer(runtime);
  const { screen, waitFor } = await import("@testing-library/react");

  for (let attempt = 1; attempt <= abortCount; attempt += 1) {
    await setPageVisible(0, true);
    await waitFor(() => assert.equal(requests, attempt));
    await setPageVisible(0, false);
    await waitFor(() =>
      assert.equal(
        pdf.pages.reduce((total, record) => total + record.calls.textAbort, 0),
        attempt,
      ),
    );
  }

  await setPageVisible(0, true);
  await screen.findByText("Text from page 1");
  assert.equal(requests, abortCount + 1);
  const successful = pdf.pages.find(
    (record) => record.calls.textRequests === 1 && record.calls.textAbort === 0,
  );
  assert.equal(successful.calls.itemBudgets[0], MAX_PDF_TEXT_ITEMS_PER_PAGE);
});

test("renders hostile page geometry through a bounded PDF.js viewport", async () => {
  const pdf = createDocument(1, (pageNumber) =>
    createPage(pageNumber, { height: 1, width: 1e9 }),
  );
  const { runtime } = createRuntime([Promise.resolve(pdf.document)]);
  await renderViewer(runtime);
  const { screen, waitFor } = await import("@testing-library/react");
  await setAllPagesVisible(true);
  await screen.findByText("Text from page 1");
  await waitFor(() =>
    assert.equal(
      pdf.pages.filter((record) => record.calls.render === 1).length,
      1,
    ),
  );

  const renderedPage = pdf.pages.find((record) => record.calls.render === 1);
  assert.equal(renderedPage.calls.viewportScales.length, 2);
  assert.equal(renderedPage.calls.viewportScales[0], 1);
  assert.ok(renderedPage.calls.viewportScales[1] < 1);
  const canvas = screen
    .getByLabelText("report.pdf, page 1")
    .querySelector("canvas");
  assert.ok(Number.parseInt(canvas.style.width, 10) <= MAX_PDF_CSS_DIMENSION);
});

test("rejects invalid page geometry before rendering", async () => {
  const pdf = createDocument(1, (pageNumber) =>
    createPage(pageNumber, { height: 792, width: Number.NaN }),
  );
  const { calls, runtime } = createRuntime([Promise.resolve(pdf.document)]);
  await renderViewer(runtime);
  const { screen } = await import("@testing-library/react");
  await setAllPagesVisible(true);

  assert.match(
    (await screen.findByRole("alert")).textContent,
    /could not be rendered/,
  );
  assert.equal(
    pdf.pages.some((record) => record.calls.render > 0),
    false,
  );
  assert.equal(calls.destroy, 1);
});

test("caps accessible text per page and announces truncation", async () => {
  const oversizedText = "a".repeat(MAX_PDF_TEXT_CHARS_PER_PAGE + 10);
  const pdf = createDocument(1, (pageNumber) =>
    createPage(pageNumber, { text: oversizedText }),
  );
  const { runtime } = createRuntime([Promise.resolve(pdf.document)]);
  await renderViewer(runtime);
  const { screen, waitFor } = await import("@testing-library/react");
  const pageText = await screen.findByTestId("workspace-pdf-text-1");
  await setAllPagesVisible(true);

  await waitFor(() =>
    assert.match(pageText.textContent, /truncated for preview/),
  );
  assert.ok(pageText.textContent.length <= MAX_PDF_TEXT_CHARS_PER_PAGE + 50);
  assert.equal(
    pdf.pages.filter((record) => record.calls.textRequests === 1).length,
    1,
  );
});

test("charges raw text against the document cap before trimming", async () => {
  const fullPage = " ".repeat(MAX_PDF_TEXT_CHARS_PER_PAGE);
  const pageCount = MAX_PDF_TEXT_CHARS_TOTAL / MAX_PDF_TEXT_CHARS_PER_PAGE + 1;
  const pdf = createDocument(pageCount, (pageNumber) =>
    createPage(pageNumber, { text: fullPage }),
  );
  const { runtime } = createRuntime([Promise.resolve(pdf.document)]);
  await renderViewer(runtime);
  const { screen, waitFor } = await import("@testing-library/react");
  const finalPageText = await screen.findByTestId(
    `workspace-pdf-text-${pageCount}`,
  );
  await setAllPagesVisible(true);

  await waitFor(() =>
    assert.match(finalPageText.textContent, /truncated for preview/),
  );
  assert.equal(
    pdf.pages.filter((record) => record.calls.textRequests === 1).length,
    pageCount - 1,
  );
});

test("caps text items per page and across the document", async () => {
  const pageCount = MAX_PDF_TEXT_ITEMS_TOTAL / MAX_PDF_TEXT_ITEMS_PER_PAGE + 1;
  const pdf = createDocument(pageCount, (pageNumber) =>
    createPage(pageNumber, {
      consumedItems: MAX_PDF_TEXT_ITEMS_PER_PAGE,
      text: "",
    }),
  );
  const { runtime } = createRuntime([Promise.resolve(pdf.document)]);
  await renderViewer(runtime);
  const { screen, waitFor } = await import("@testing-library/react");
  const finalPageText = await screen.findByTestId(
    `workspace-pdf-text-${pageCount}`,
  );
  await setAllPagesVisible(true);

  await waitFor(() =>
    assert.match(finalPageText.textContent, /truncated for preview/),
  );
  assert.equal(
    pdf.pages.filter((record) => record.calls.textRequests === 1).length,
    pageCount - 1,
  );
  assert.equal(
    pdf.pages
      .filter((record) => record.calls.textRequests === 1)
      .every(
        (record) => record.calls.itemBudgets[0] === MAX_PDF_TEXT_ITEMS_PER_PAGE,
      ),
    true,
  );
});

test("aborts in-flight accessible text extraction on unmount", async () => {
  const textJob = deferred();
  const pdf = createDocument(1, (pageNumber) =>
    createPage(pageNumber, { textDeferred: textJob }),
  );
  const { calls, runtime } = createRuntime([Promise.resolve(pdf.document)]);
  const view = await renderViewer(runtime);
  const { act, waitFor } = await import("@testing-library/react");
  await setAllPagesVisible(true);
  await waitFor(() =>
    assert.equal(
      pdf.pages.filter((record) => record.calls.textRequests === 1).length,
      1,
    ),
  );

  await act(async () => view.unmount());
  const textPage = pdf.pages.find((record) => record.calls.textRequests === 1);
  await waitFor(() => assert.equal(textPage.calls.textAbort, 1));
  assert.equal(textPage.calls.cleanup, 1);
  assert.equal(calls.destroy, 1);
});

test("releases an offscreen page canvas and PDF.js page resources", async () => {
  const pdf = createDocument(1);
  const { runtime } = createRuntime([Promise.resolve(pdf.document)]);
  await renderViewer(runtime);
  const { screen, waitFor } = await import("@testing-library/react");
  await screen.findByLabelText("report.pdf, page 1");
  await setAllPagesVisible(true);
  await screen.findByText("Text from page 1");

  const canvas = screen
    .getByLabelText("report.pdf, page 1")
    .querySelector("canvas");
  assert.ok(canvas.width > 0);
  await setAllPagesVisible(false);
  const renderedPage = pdf.pages.find((record) => record.calls.render === 1);
  await waitFor(() => assert.equal(renderedPage.calls.cleanup, 1));
  assert.equal(canvas.width, 0);
  assert.equal(canvas.height, 0);
});

test("cancels active rendering on zoom and unmount", async () => {
  const pdf = createDocument(1, (pageNumber) => {
    const job = deferred();
    return createPage(pageNumber, { renderDeferred: job });
  });
  const { runtime } = createRuntime([Promise.resolve(pdf.document)]);
  const view = await renderViewer(runtime);
  const { fireEvent, screen, waitFor } = await import("@testing-library/react");
  await screen.findByLabelText("report.pdf, page 1");
  await setAllPagesVisible(true);
  await waitFor(() =>
    assert.equal(
      pdf.pages.filter((record) => record.calls.render === 1).length,
      1,
    ),
  );

  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  await waitFor(() =>
    assert.equal(
      pdf.pages.filter((record) => record.calls.render === 1).length,
      2,
    ),
  );
  const renderedPages = pdf.pages.filter((record) => record.calls.render === 1);
  assert.equal(renderedPages[0].calls.cancel, 1);
  assert.equal(renderedPages[0].calls.cleanup, 1);

  view.unmount();
  assert.equal(renderedPages[1].calls.cancel, 1);
  assert.equal(renderedPages[1].calls.cleanup, 1);
});

test("zoom controls report and enforce the supported range", async () => {
  const pdf = createDocument(1);
  const { runtime } = createRuntime([Promise.resolve(pdf.document)]);
  await renderViewer(runtime);
  const { fireEvent, screen } = await import("@testing-library/react");
  await setAllPagesVisible(true);
  await screen.findByText("Text from page 1");
  const zoomOut = screen.getByRole("button", { name: "Zoom out" });
  const zoomIn = screen.getByRole("button", { name: "Zoom in" });

  for (let click = 0; click < 8; click++) fireEvent.click(zoomOut);
  assert.equal(screen.getByTestId("workspace-pdf-zoom").textContent, "50%");
  assert.equal(zoomOut.disabled, true);

  for (let click = 0; click < 12; click++) fireEvent.click(zoomIn);
  assert.equal(screen.getByTestId("workspace-pdf-zoom").textContent, "250%");
  assert.equal(zoomIn.disabled, true);
});

test("worker load failure has alert semantics and retry starts a fresh task", async () => {
  const firstLoad = deferred();
  const pdf = createDocument(1);
  const { calls, runtime } = createRuntime([
    firstLoad.promise,
    Promise.resolve(pdf.document),
  ]);
  let retries = 0;
  await renderViewer(runtime, () => {
    retries += 1;
  });
  const { act, fireEvent, screen } = await import("@testing-library/react");

  await act(async () => firstLoad.reject(new Error("worker failed")));
  assert.match(
    (await screen.findByRole("alert")).textContent,
    /could not be rendered/,
  );
  assert.doesNotMatch(screen.getByRole("alert").textContent, /worker failed/);
  assert.equal(calls.destroy, 1);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  assert.match((await screen.findByRole("status")).textContent, /1 pages/);
  await setAllPagesVisible(true);
  await screen.findByText("Text from page 1");
  assert.equal(calls.load, 2);
  assert.equal(calls.destroy, 1);
  assert.equal(retries, 1);
});

test("waits for one deferred destroy before exposing Retry", async () => {
  const firstLoad = deferred();
  const destroyJob = deferred();
  const { calls, runtime } = createRuntime([firstLoad.promise], {
    destroyDeferred: destroyJob,
  });
  await renderViewer(runtime);
  const { act, screen } = await import("@testing-library/react");

  await act(async () => firstLoad.reject(new Error("worker failed")));
  assert.equal(calls.destroy, 1);
  assert.equal(screen.queryByRole("alert"), null);
  assert.equal(screen.queryByRole("button", { name: "Retry" }), null);

  await act(async () => destroyJob.resolve());
  assert.ok(await screen.findByRole("alert"));
  assert.ok(screen.getByRole("button", { name: "Retry" }));
  assert.equal(calls.destroy, 1);
});

test("rejects excessive page counts before creating page DOM or work", async () => {
  const pdf = createDocument(MAX_PDF_WORKSPACE_PAGES + 1);
  const { calls, runtime } = createRuntime([Promise.resolve(pdf.document)]);
  await renderViewer(runtime);
  const { screen } = await import("@testing-library/react");

  assert.match(
    (await screen.findByRole("alert")).textContent,
    /could not be rendered/,
  );
  assert.equal(screen.queryByLabelText(/report\.pdf, page/), null);
  assert.equal(pdf.pages.length, 0);
  assert.equal(calls.destroy, 1);
});

test("text extraction failure destroys the worker before showing retry", async () => {
  const pdf = createDocument(1, (pageNumber) =>
    createPage(pageNumber, { textError: new Error("text failed") }),
  );
  const { calls, runtime } = createRuntime([Promise.resolve(pdf.document)]);
  await renderViewer(runtime);
  const { screen } = await import("@testing-library/react");

  await setAllPagesVisible(true);
  await screen.findByRole("alert");
  assert.equal(calls.destroy, 1);
  assert.ok(screen.getByRole("button", { name: "Retry" }));
});

test("render failure can retry the document", async () => {
  const failedPage = createDocument(1, (pageNumber) => {
    const record = createPage(pageNumber);
    return {
      ...record,
      page: {
        ...record.page,
        render() {
          return {
            cancel() {},
            promise: Promise.reject(new Error("render failed")),
          };
        },
      },
    };
  });
  const recovered = createDocument(1);
  const { calls, runtime } = createRuntime([
    Promise.resolve(failedPage.document),
    Promise.resolve(recovered.document),
  ]);
  await renderViewer(runtime);
  const { fireEvent, screen } = await import("@testing-library/react");
  await screen.findByLabelText("report.pdf, page 1");
  await setAllPagesVisible(true);
  await screen.findByRole("alert");
  assert.equal(calls.destroy, 1);

  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  assert.match(
    (await screen.findByTestId("workspace-pdf-status")).textContent,
    /1 pages/,
  );
  await setAllPagesVisible(true);
  await screen.findByText("Text from page 1");
  assert.equal(calls.load, 2);
});

test("rapid zoom followed by unmount leaves no active render task", async () => {
  const pdf = createDocument(1, (pageNumber) =>
    createPage(pageNumber, { renderDeferred: deferred() }),
  );
  const { runtime } = createRuntime([Promise.resolve(pdf.document)]);
  const view = await renderViewer(runtime);
  const { act, fireEvent, screen, waitFor } = await import(
    "@testing-library/react"
  );
  await screen.findByLabelText("report.pdf, page 1");
  await setAllPagesVisible(true);
  await waitFor(() =>
    assert.equal(
      pdf.pages.filter((record) => record.calls.render === 1).length,
      1,
    ),
  );

  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  await act(async () => view.unmount());
  await waitFor(() =>
    assert.equal(
      pdf.pages.every((record) => record.calls.cleanup >= 1),
      true,
    ),
  );

  assert.equal(
    pdf.pages.every((record) => record.calls.cleanup >= 1),
    true,
  );
  assert.equal(
    pdf.pages
      .filter((record) => record.calls.render > 0)
      .every((record) => record.calls.cancel >= 1),
    true,
  );
});
