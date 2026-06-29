import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import duplicateBridgeRuntime from "../../../server/duplicateBridgeRuntime.cjs";

const { JsonLineBridgeClient } = duplicateBridgeRuntime;

describe("JsonLineBridgeClient", () => {
  it("rejects and tears down a request that never receives a JSON line", async () => {
    const client = new JsonLineBridgeClient({
      command: process.execPath,
      args: ["-e", "process.stdin.resume()"],
      cwd: process.cwd(),
      env: process.env,
      requestTimeoutMs: 25,
    });

    await expect(client.request({ action: "warmup" })).rejects.toThrow(
      /timed out/i,
    );
    expect(client.proc).toBeNull();
  });

  it("retries once with a fresh process after a bridge timeout", async () => {
    const markerPath = path.join(os.tmpdir(), `dup-bridge-retry-${process.pid}-${Date.now()}.txt`);
    const childScript = `
const fs = require('node:fs');
const readline = require('node:readline');
const marker = process.env.DUP_BRIDGE_RETRY_MARKER;
const current = fs.existsSync(marker) ? Number(fs.readFileSync(marker, 'utf8') || '0') : 0;
fs.writeFileSync(marker, String(current + 1));
if (current === 0) {
  process.stdin.resume();
} else {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', () => { process.stdout.write(JSON.stringify({ success: true, retried: true }) + '\\n'); });
}
`;

    const client = new JsonLineBridgeClient({
      command: process.execPath,
      args: ["-e", childScript],
      cwd: process.cwd(),
      env: { ...process.env, DUP_BRIDGE_RETRY_MARKER: markerPath },
      requestTimeoutMs: 25,
    });

    await expect(client.request({ action: "search" })).resolves.toEqual({
      success: true,
      retried: true,
    });
    expect(fs.readFileSync(markerPath, "utf8")).toBe("2");
    client.dispose();
  });
});
