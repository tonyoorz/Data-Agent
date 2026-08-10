import fs from "node:fs";
import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));

const required = {
  "@langchain/core": "1.2.2",
  "@langchain/langgraph": "1.4.7",
  "@langchain/langgraph-checkpoint-sqlite": "1.0.3",
  ajv: "8.20.0",
  "ajv-formats": "3.0.1",
  "better-sqlite3": "12.11.1",
};

const requiredDev = { "@types/node": "24.13.3" };

describe("main Agent Runtime dependencies", () => {
  it("pins every direct Runtime dependency and Node major", () => {
    expect(packageJson.engines).toEqual({ node: "24.x" });

    for (const [name, version] of Object.entries(required)) {
      expect(packageJson.dependencies?.[name]).toBe(version);
      expect(lock.packages?.[""]?.dependencies?.[name]).toBe(version);
      expect(lock.packages?.[`node_modules/${name}`]?.version).toBe(version);
    }

    for (const [name, version] of Object.entries(requiredDev)) {
      expect(packageJson.devDependencies?.[name]).toBe(version);
      expect(lock.packages?.[""]?.devDependencies?.[name]).toBe(version);
      expect(lock.packages?.[`node_modules/${name}`]?.version).toBe(version);
    }
  });
});