import { randomBytes } from "node:crypto";
import net from "node:net";

const LOCAL_INTERNAL_ROW_SCOPE_KEYS = [
  "VIZION_INTERNAL_TEAM_IDS",
  "VIZION_INTERNAL_PROJECT_IDS",
  "VIZION_INTERNAL_WORKSPACE_IDS",
];
const LOCAL_INTERNAL_ROW_POLICY = "agent.operations.read";
const ANALYTICS_API_ENV_KEYS = [
  "VIZION_AGENT_ACTOR_CAPABILITY_SECRET",
  "VIZION_ANALYTICS_DB_PATH",
  "VIZION_ANALYTICS_PORT",
  "VIZION_DATABASE_ROOT",
  "VIZION_FULL_PICTURE_DEFECT_DB_PATH",
  "VIZION_FULL_PICTURE_HISTORY_DB_PATH",
  "VIZION_FULL_PICTURE_HOT_DB_PATH",
  "VIZION_FULL_PICTURE_SOURCE_DB_PATH",
  "VIZION_OCTANE_FIELD_CATALOG_PATH",
  "VIZION_ONTOLOGY_FINGERPRINT",
  "VIZION_ONTOLOGY_ROOT",
  "VIZION_REPO_ROOT_OVERRIDE",
  "VIZION_SEMANTIC_ANALYSIS_DB_PATH",
];
const ANALYTICS_CLI_ENV_KEYS = [
  ...ANALYTICS_API_ENV_KEYS.filter((key) => key !== "VIZION_AGENT_ACTOR_CAPABILITY_SECRET"),
  "PLAYWRIGHT_BROWSERS_PATH",
  "VIZION_FULL_PICTURE_COLD_DB_PATH",
  "VIZION_FULL_PICTURE_COLD_PARQUET_DIR",
  "VIZION_NODE_EXE",
  "VIZION_OCTANE_BASE_URL",
  "VIZION_OCTANE_BROWSER_PROFILE",
  "VIZION_OCTANE_COOKIE_FILE",
  "VIZION_OCTANE_LOGIN_FILE",
  "VIZION_OCTANE_SHARED_SPACE_ID",
  "VIZION_OCTANE_WORKSPACE_ID",
  "VIZION_WINDOWS_HELLO_PIN",
];
const ANALYTICS_TASK_ENV_KEYS = [
  ...ANALYTICS_API_ENV_KEYS.filter((key) => key !== "VIZION_AGENT_ACTOR_CAPABILITY_SECRET"),
  "VIZION_FULL_PICTURE_COLD_DB_PATH",
  "VIZION_FULL_PICTURE_COLD_PARQUET_DIR",
  "VIZION_NODE_EXE",
];
const CHILD_PROCESS_BASE_ENV_KEYS = new Set([
  "CI",
  "COMSPEC",
  "DYLD_LIBRARY_PATH",
  "FORCE_COLOR",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "LANG",
  "LC_ALL",
  "LD_LIBRARY_PATH",
  "LOCALAPPDATA",
  "LOGNAME",
  "NO_COLOR",
  "NO_PROXY",
  "PATH",
  "PATHEXT",
  "Path",
  "REQUESTS_CA_BUNDLE",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "USERPROFILE",
  "http_proxy",
  "https_proxy",
  "no_proxy",
]);

function selectChildEnvironment(env, { keys = [], prefixes = [] } = {}) {
  const allowedKeys = new Set([...CHILD_PROCESS_BASE_ENV_KEYS, ...keys]);
  return Object.fromEntries(Object.entries(env || {}).filter(([key]) => (
    allowedKeys.has(key) || prefixes.some((prefix) => key.startsWith(prefix))
  )));
}

export function resolveDevelopmentPort(value, fallback, name) {
  const configured = String(value || "").trim();
  if (!configured) return fallback;
  if (!/^\d+$/u.test(configured)) throw new Error(`${name}_INVALID`);
  const port = Number(configured);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${name}_INVALID`);
  return port;
}

export function resolveAnalyticsChildEnvironment(env = process.env) {
  return {
    ...selectChildEnvironment(env, {
    keys: [
      "PYTHONIOENCODING",
      "PYTHONNOUSERSITE",
      "PYTHONUTF8",
      ...ANALYTICS_API_ENV_KEYS,
    ],
    }),
    PYTHONIOENCODING: "utf-8",
    PYTHONNOUSERSITE: "1",
    PYTHONUTF8: "1",
  };
}

export function resolveAnalyticsCliEnvironment(env = process.env) {
  return {
    ...selectChildEnvironment(env, {
    keys: [
      "PYTHONIOENCODING",
      "PYTHONNOUSERSITE",
      "PYTHONUTF8",
      ...ANALYTICS_CLI_ENV_KEYS,
    ],
    }),
    PYTHONIOENCODING: "utf-8",
    PYTHONNOUSERSITE: "1",
    PYTHONUTF8: "1",
  };
}

export function resolveAnalyticsTaskEnvironment(env = process.env) {
  return {
    ...selectChildEnvironment(env, {
      keys: [
        "PYTHONIOENCODING",
        "PYTHONNOUSERSITE",
        "PYTHONUTF8",
        ...ANALYTICS_TASK_ENV_KEYS,
      ],
    }),
    PYTHONIOENCODING: "utf-8",
    PYTHONNOUSERSITE: "1",
    PYTHONUTF8: "1",
  };
}

export function resolveViteChildEnvironment(env = process.env) {
  return selectChildEnvironment(env, {
    prefixes: ["VITE_"],
    keys: [
      "NODE_ENV",
      "NODE_EXTRA_CA_CERTS",
      "VIZION_ANALYTICS_API_BASE",
      "VIZION_ANALYTICS_PORT",
      "VIZION_API_PORT",
      "VIZION_WEB_PORT",
    ],
  });
}

export function resolveLocalApiEnvironment(env = process.env) {
  const authMode = String(env?.VIZION_AGENT_AUTH_MODE || "").trim();
  const localEnv = {
    ...env,
    VIZION_AGENT_AUTH_MODE: authMode || "internal",
  };
  const isInternalMode = localEnv.VIZION_AGENT_AUTH_MODE.toLowerCase() === "internal";
  const capabilitySecret = String(env?.VIZION_AGENT_ACTOR_CAPABILITY_SECRET || "").trim();
  if (isInternalMode && !capabilitySecret) {
    localEnv.VIZION_AGENT_ACTOR_CAPABILITY_SECRET = randomBytes(32).toString("base64url");
  }
  const hasRowScope = LOCAL_INTERNAL_ROW_SCOPE_KEYS.some((key) => String(env?.[key] || "").trim());
  if (isInternalMode && !hasRowScope) {
    localEnv.VIZION_INTERNAL_TEAM_IDS = "DTSV_China";
  }
  const rowPolicyIds = String(env?.VIZION_INTERNAL_ROW_POLICY_IDS || "").trim();
  if (isInternalMode && !rowPolicyIds) {
    localEnv.VIZION_INTERNAL_ROW_POLICY_IDS = LOCAL_INTERNAL_ROW_POLICY;
  }
  return localEnv;
}

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

function createFetchTimeout(timeoutMs) {
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    typeof AbortController === "undefined"
  ) {
    return undefined;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  return {
    options: { signal: controller.signal },
    clear: () => clearTimeout(timeout),
  };
}

async function fetchWithTimeout(fetchImpl, url, timeoutMs) {
  const timeout = createFetchTimeout(timeoutMs);
  try {
    return timeout ? await fetchImpl(url, timeout.options) : await fetchImpl(url);
  } finally {
    timeout?.clear();
  }
}

export async function hasHealthyServiceOnPort({
  port,
  expectedService,
  fetchImpl = globalThis.fetch,
  timeoutMs = 2000,
}) {
  if (!Number.isInteger(port) || port <= 0 || typeof fetchImpl !== "function") {
    return false;
  }

  try {
    const response = await fetchWithTimeout(fetchImpl, `http://127.0.0.1:${port}/health`, timeoutMs);
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

export async function hasTcpServiceOnPort({
  port,
  host = "127.0.0.1",
  timeoutMs = 500,
  connectImpl = (options) => net.createConnection(options),
}) {
  if (!Number.isInteger(port) || port <= 0 || typeof connectImpl !== "function") {
    return false;
  }

  return new Promise((resolve) => {
    let settled = false;
    let socket;

    const settle = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      socket?.destroy?.();
      resolve(result);
    };

    try {
      socket = connectImpl({ host, port });
      socket.once("connect", () => settle(true));
      socket.once("error", () => settle(false));
      socket.setTimeout?.(timeoutMs, () => settle(false));
    } catch {
      settle(false);
    }
  });
}

export async function waitForHealthyService(isHealthy, { attempts = 8, delayMs = 250 } = {}) {
  if (typeof isHealthy !== "function") {
    return false;
  }

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await isHealthy()) {
      return true;
    }

    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return false;
}


export async function hasViteDevServerOnPort({
  port,
  fetchImpl = globalThis.fetch,
  timeoutMs = 2000,
}) {
  if (!Number.isInteger(port) || port <= 0 || typeof fetchImpl !== "function") {
    return false;
  }

  try {
    const response = await fetchWithTimeout(fetchImpl, `http://127.0.0.1:${port}/`, timeoutMs);
    return response?.ok === true;
  } catch {
    return false;
  }
}
