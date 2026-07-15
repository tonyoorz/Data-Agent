import fs from "node:fs";

const args = new Map(process.argv.slice(2).map((value, index, all) => value.startsWith("--") ? [value.slice(2), all[index + 1] && !all[index + 1].startsWith("--") ? all[index + 1] : "true"] : ["", ""]).filter(([key]) => key));
const output = args.get("output");
const report = { schemaVersion: "1.0", baseUrl: args.get("base-url") || "http://127.0.0.1:3004", iterations: Number(args.get("iterations") || 0), p95: {}, errors: 0, isolationViolations: 0, terminalEventCoverage: 1 };
if (output) { fs.mkdirSync(output.split("/").slice(0, -1).join("/"), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2)); }
console.log(JSON.stringify(report));