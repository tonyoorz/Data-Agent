import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("durable LangGraph checkpoint runtime", () => {
  it("loads the Node-native SQLite binding and creates a usable saver", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "data-agent-checkpoint-integration-"));
    temporaryRoots.push(root);
    const dbPath = path.join(root, "agent.db");
    const { SqliteSaver } = await import("@langchain/langgraph-checkpoint-sqlite");
    const saver = await SqliteSaver.fromConnString(dbPath);
    try {
      await saver.setup();
      expect(fs.existsSync(dbPath)).toBe(true);
      expect(saver.db).toBeTruthy();
    } finally {
      saver.db?.close?.();
    }
  });
});
