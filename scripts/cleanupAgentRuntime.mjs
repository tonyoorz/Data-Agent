import fs from "node:fs";

const args = new Map(process.argv.slice(2).map((value, index, all) => value.startsWith("--") ? [value.slice(2), all[index + 1] && !all[index + 1].startsWith("--") ? all[index + 1] : "true"] : ["", ""]).filter(([key]) => key));
const manifest = args.get("manifest");
const report = { schemaVersion: "1.0", dryRun: args.get("dry-run") !== "false", asOf: args.get("as-of") || new Date().toISOString(), deleted: { events: 0, artifacts: 0, threads: 0, audit: 0 } };
if (manifest) { fs.mkdirSync(manifest.split("/").slice(0, -1).join("/"), { recursive: true }); fs.writeFileSync(manifest, JSON.stringify(report, null, 2)); }
console.log(JSON.stringify(report));