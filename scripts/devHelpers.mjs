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