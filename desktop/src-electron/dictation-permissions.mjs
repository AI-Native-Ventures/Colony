/** Grant microphone-only access to the trusted desktop main frame. */
export function installDictationPermissions(owner, trusted) {
  const trustedFrame = (contents, details) => {
    try {
      return (
        contents === owner &&
        details?.isMainFrame === true &&
        trusted(owner.getURL()) &&
        trusted(details.requestingUrl)
      );
    } catch {
      return false;
    }
  };
  owner.session.setPermissionRequestHandler(
    (contents, permission, callback, details) => {
      callback(
        permission === "media" &&
          trustedFrame(contents, details) &&
          Array.isArray(details.mediaTypes) &&
          details.mediaTypes.length === 1 &&
          details.mediaTypes[0] === "audio",
      );
    },
  );
  owner.session.setPermissionCheckHandler(
    (contents, permission, _origin, details) =>
      permission === "media" &&
      trustedFrame(contents, details) &&
      details.mediaType === "audio",
  );
}
