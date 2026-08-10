const SUPPORTED_NODE_MAJOR = 24;

export function assertSupportedNodeVersion() {
  const version = process.versions.node || "";
  const major = Number.parseInt(version.split(".")[0] || "", 10);

  if (!Number.isFinite(major) || major !== SUPPORTED_NODE_MAJOR) {
    throw new Error(
      `Unsupported Node.js version ${version}. Please use Node ${SUPPORTED_NODE_MAJOR}.x.`,
    );
  }
}
