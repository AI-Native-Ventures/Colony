/** Error thrown by website preview validation and loading. */
export class PreviewArtifactError extends Error {
  /**
   * @param {string} code stable machine-readable error code
   * @param {string} message human-readable message
   * @param {Record<string, unknown>} [details] optional structured context
   */
  constructor(code, message, details) {
    super(message);
    this.name = "PreviewArtifactError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
