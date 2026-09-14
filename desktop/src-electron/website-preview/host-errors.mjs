/** Error thrown by the isolated website preview host. */
export class PreviewHostError extends Error {
  /**
   * @param {string} code stable machine-readable error code
   * @param {string} message human-readable message
   * @param {Record<string, unknown>} [details] optional structured context
   */
  constructor(code, message, details) {
    super(message);
    this.name = "PreviewHostError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
