/**
 * Node bridge runtime for the test-case creation Python bridge.
 *
 * Mirrors `duplicateBridgeRuntime.cjs` — spawns `python scripts/testcase_bridge.py --server`
 * as a persistent child process and communicates via JSON-lines. Exports `runTestCaseBridge()`
 * for the server endpoints in `index.mjs`.
 *
 * The `JsonLineBridgeClient` class is reused from `duplicateBridgeRuntime.cjs` (it's generic —
 * it just spawns a process and shuttles JSON lines back and forth).
 */
const { JsonLineBridgeClient, detectRepoRoot, resolvePythonExecutable } = require('./duplicateBridgeRuntime.cjs');
const path = require('node:path');
const fs = require('node:fs');

const repoRoot = detectRepoRoot();
const bridgeScript = path.join(repoRoot, 'scripts', 'testcase_bridge.py');

let testcaseBridgeClient = null;

function getTestCaseBridgeClient() {
  if (!testcaseBridgeClient) {
    testcaseBridgeClient = new JsonLineBridgeClient({
      command: resolvePythonExecutable(repoRoot),
      args: [bridgeScript, '--server'],
      cwd: repoRoot,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
      },
      requestTimeoutMs: Number(process.env.TESTCASE_BRIDGE_REQUEST_TIMEOUT_MS || 60000),
      searchRequestTimeoutMs: Number(process.env.TESTCASE_BRIDGE_SEARCH_TIMEOUT_MS || 300000),
    });
  }

  return testcaseBridgeClient;
}

function stopTestCaseBridgeRuntime() {
  if (!testcaseBridgeClient) {
    return;
  }

  testcaseBridgeClient.dispose();
  testcaseBridgeClient = null;
}

async function runTestCaseBridge(payload) {
  return getTestCaseBridgeClient().request(payload);
}

module.exports = {
  runTestCaseBridge,
  stopTestCaseBridgeRuntime,
  getTestCaseBridgeClient,
};
