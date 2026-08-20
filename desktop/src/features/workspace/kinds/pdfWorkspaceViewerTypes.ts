export type PdfViewport = {
  height: number;
  width: number;
};

export type PdfRenderTask = {
  cancel: () => void;
  promise: Promise<unknown>;
};

export type PdfPage = {
  cleanup: () => boolean;
  getTextContent: () => Promise<{
    items: Array<{ str: string } | { type: string }>;
  }>;
  getViewport: (options: { scale: number }) => PdfViewport;
  render: (options: {
    canvas: HTMLCanvasElement;
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
