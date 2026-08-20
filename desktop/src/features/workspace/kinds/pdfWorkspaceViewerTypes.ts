export type PdfViewport = {
  height: number;
  width: number;
};

export type PdfAccessibleText = {
  text: string;
  truncated: boolean;
};

export type PdfRenderTask = {
  cancel: () => void;
  promise: Promise<unknown>;
};

export type PdfPage = {
  cleanup: () => boolean;
  getTextContent: (options: {
    maxCharacters: number;
    maxItems: number;
    signal: AbortSignal;
  }) => Promise<{
    consumedCharacters: number;
    consumedItems: number;
    items: Array<{ str: string } | { type: string }>;
    truncated: boolean;
  }>;
  getViewport: (options: { scale: number }) => PdfViewport;
  render: (options: {
    canvas: HTMLCanvasElement;
    intent?: "display" | "print";
    operationsFilter?: (operationIndex: number) => boolean;
    transform?: [number, number, number, number, number, number];
    viewport: PdfViewport;
  }) => PdfRenderTask;
};

export type PdfDocument = {
  getPage: (pageNumber: number) => Promise<PdfPage>;
  numPages: number;
};

export type PdfLoadingTask = {
  destroy: () => Promise<void>;
  promise: Promise<PdfDocument>;
};

export type PdfViewerRuntime = {
  isCancelledRender: (cause: unknown) => boolean;
  loadDocument: (data: Uint8Array) => PdfLoadingTask;
};
