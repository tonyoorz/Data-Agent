export function getTerminationCommand(platform, pid, signal = "SIGTERM") {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }

  if (platform === "win32") {
    return {
      command: "taskkill",
      args: ["/PID", String(pid), "/T", "/F"],
    };
  }

  return {
    command: null,
    args: [signal],
  };
}

export async function hasHealthyServiceOnPort({
  port,
  expectedService,
  fetchImpl = globalThis.fetch,
}) {
  if (!Number.isInteger(port) || port <= 0 || typeof fetchImpl !== "function") {
    return false;
  }

  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/health`);
    if (!response?.ok) {
      return false;
    }

    const payload = await response.json();
    if (!payload || payload.ok !== true) {
      return false;
    }

    if (expectedService) {
      return payload.service === expectedService;
    }

    return true;
  } catch {
    return false;
  }
}