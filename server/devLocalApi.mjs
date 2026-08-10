import { resolveLocalApiEnvironment } from "../scripts/devHelpers.mjs";
import { loadLocalEnv } from "./loadLocalEnv.mjs";

loadLocalEnv();
Object.assign(process.env, resolveLocalApiEnvironment(process.env));

await import("./index.mjs");