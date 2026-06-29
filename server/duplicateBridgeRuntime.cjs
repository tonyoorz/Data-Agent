const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

function detectRepoRoot() {
  const cwd = process.cwd();
  const candidates = [cwd, path.resolve(cwd, '..')];

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'backend', 'duplicate_issue_finder.py'))) {
      return candidate;
    }
  }

  return candidates[0];
}

function resolvePythonExecutable(repoRoot) {
  const literalCandidates = process.platform === 'win32'
    ? ['python', 'py', 'python3']
    : ['python3', 'python'];

  const candidates = [
    process.env.DUPSEARCH_AGENT_PYTHON,
    process.env.AGENT_UI_PYTHON,
    path.join(repoRoot, '.venv', 'Scripts', 'python.exe'),
    path.join(repoRoot, '.venv', 'bin', 'python'),
    path.join(repoRoot, '.venv', 'bin', 'python3'),
    path.join(process.cwd(), '.venv', 'Scripts', 'python.exe'),
    path.join(process.cwd(), '.venv', 'bin', 'python'),
    path.join(process.cwd(), '.venv', 'bin', 'python3'),
    ...literalCandidates,
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (literalCandidates.includes(candidate)) {
      return candidate;
    }
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return process.platform === 'win32' ? 'python' : 'python3';
}

function resolveRequestTimeoutMs(options = {}, env = process.env) {
  const raw = Number(options.requestTimeoutMs || env.DUPSEARCH_BRIDGE_REQUEST_TIMEOUT_MS || 45000);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 45000;
  }
  return Math.max(100, Math.floor(raw));
}

function isRetryableBridgeError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  return /timed out|exited before responding|Bridge process failed|EPIPE|stdin/i.test(message);
}

class JsonLineBridgeClient {
  constructor(options) {
    this.options = { ...options };
    this.requestTimeoutMs = resolveRequestTimeoutMs(options);
    this.proc = null;
    this.stdoutReader = null;
    this.pending = [];
    this.stderr = '';
    this.requestChain = Promise.resolve();
    this.disposed = false;
  }

  request(payload) {
    const run = () => this._sendWithRetry(payload);
    this.requestChain = this.requestChain.then(run, run);
    return this.requestChain;
  }

  async _sendWithRetry(payload) {
    try {
      return await this._send(payload);
    } catch (error) {
      if (this.disposed || !isRetryableBridgeError(error)) {
        throw error;
      }
      return this._send(payload);
    }
  }

  dispose() {
    this.disposed = true;
    this._teardownProcess();
  }

  _send(payload) {
    if (this.disposed) {
      return Promise.reject(new Error('Bridge client has been disposed'));
    }

    const proc = this._ensureProcess();

    return new Promise((resolve, reject) => {
      let timer = null;
      const pending = {
        resolve: (value) => {
          if (timer) {
            clearTimeout(timer);
          }
          resolve(value);
        },
        reject: (error) => {
          if (timer) {
            clearTimeout(timer);
          }
          reject(error);
        },
      };

      timer = setTimeout(() => {
        const index = this.pending.indexOf(pending);
        if (index >= 0) {
          this.pending.splice(index, 1);
        }
        pending.reject(new Error(`Bridge request timed out after ${this.requestTimeoutMs}ms`));
        this._teardownProcess(proc);
      }, this.requestTimeoutMs);
      timer.unref?.();

      this.pending.push(pending);
      proc.stdin.write(`${JSON.stringify(payload)}\n`, 'utf8');
    });
  }

  _ensureProcess() {
    if (this.proc && this.proc.exitCode === null && !this.proc.killed && !this.proc.stdin.destroyed) {
      return this.proc;
    }

    const proc = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc = proc;
    this.stderr = '';
    this.stdoutReader = readline.createInterface({
      input: proc.stdout,
      crlfDelay: Infinity,
    });

    this.stdoutReader.on('line', (line) => {
      this._handleStdoutLine(line);
    });

    proc.stderr.on('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(-8000);
    });

    proc.on('error', (error) => {
      this._rejectAll(error instanceof Error ? error : new Error(String(error)));
      this._teardownProcess();
    });

    proc.on('close', (code) => {
      setImmediate(() => {
        if (this.proc !== proc) {
          return;
        }

        if (this.pending.length > 0) {
          const message = code === 0
            ? 'Bridge process exited before responding'
            : `Bridge process failed with code ${code}: ${this.stderr.slice(-1000)}`;
          this._rejectAll(new Error(message));
        }
        this._teardownProcess(proc);
      });
    });

    return proc;
  }

  _handleStdoutLine(line) {
    if (!line.trim()) {
      return;
    }

    const next = this.pending.shift();
    if (!next) {
      return;
    }

    try {
      next.resolve(JSON.parse(line));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      next.reject(new Error(`Invalid JSON payload from bridge: ${reason}`));
    }
  }

  _rejectAll(error) {
    while (this.pending.length > 0) {
      const next = this.pending.shift();
      next.reject(error);
    }
  }

  _teardownProcess(targetProc = this.proc) {
    if (targetProc && this.proc && targetProc !== this.proc) {
      return;
    }

    if (this.stdoutReader) {
      this.stdoutReader.removeAllListeners();
      this.stdoutReader.close();
      this.stdoutReader = null;
    }

    if (this.proc) {
      this.proc.removeAllListeners();
      if (this.proc.exitCode === null && !this.proc.killed) {
        this.proc.kill();
      }
      this.proc = null;
    }
  }
}

function createJsonLineBridgeClient(options) {
  return new JsonLineBridgeClient(options);
}

const repoRoot = detectRepoRoot();
const bridgeScript = path.join(repoRoot, 'scripts', 'duplicate_search_bridge.py');

let duplicateBridgeClient = null;

function getDuplicateBridgeClient() {
  if (!duplicateBridgeClient) {
    duplicateBridgeClient = createJsonLineBridgeClient({
      command: resolvePythonExecutable(repoRoot),
      args: [bridgeScript, '--server'],
      cwd: repoRoot,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
      },
      requestTimeoutMs: Number(process.env.DUPSEARCH_BRIDGE_REQUEST_TIMEOUT_MS || 45000),
    });
  }

  return duplicateBridgeClient;
}

function stopDuplicateBridgeRuntime() {
  if (!duplicateBridgeClient) {
    return;
  }

  duplicateBridgeClient.dispose();
  duplicateBridgeClient = null;
}

async function runDuplicateBridge(payload) {
  return getDuplicateBridgeClient().request(payload);
}

module.exports = {
  JsonLineBridgeClient,
  createJsonLineBridgeClient,
  detectRepoRoot,
  isRetryableBridgeError,
  resolvePythonExecutable,
  resolveRequestTimeoutMs,
  runDuplicateBridge,
  stopDuplicateBridgeRuntime,
};