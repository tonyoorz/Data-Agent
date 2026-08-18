import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { loadLocalEnv } from "../server/loadLocalEnv.mjs";
import { transcribeAudio } from "../server/transcribe.mjs";

const MIN_SAMPLE_COUNT = 30;
const MAX_SAMPLE_COUNT = 50;

function normalizeForComparison(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "");
}

function levenshteinDistance(left, right) {
  const source = Array.from(left);
  const target = Array.from(right);
  let previous = Array.from({ length: target.length + 1 }, (_, index) => index);

  for (let sourceIndex = 1; sourceIndex <= source.length; sourceIndex += 1) {
    const current = [sourceIndex];
    for (let targetIndex = 1; targetIndex <= target.length; targetIndex += 1) {
      current[targetIndex] = Math.min(
        current[targetIndex - 1] + 1,
        previous[targetIndex] + 1,
        previous[targetIndex - 1] + (source[sourceIndex - 1] === target[targetIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }

  return previous[target.length];
}

export function characterErrorRate(reference, transcript) {
  const normalizedReference = normalizeForComparison(reference);
  const normalizedTranscript = normalizeForComparison(transcript);
  const referenceChars = Array.from(normalizedReference).length;
  const distance = levenshteinDistance(normalizedReference, normalizedTranscript);

  return {
    distance,
    referenceChars,
    rate: referenceChars ? distance / referenceChars : null,
  };
}

function percentile(values, percentileValue) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * percentileValue;
  const lowerIndex = Math.floor(index);
  const upperIndex = Math.ceil(index);
  const lower = sorted[lowerIndex];
  const upper = sorted[upperIndex];
  return lower + (upper - lower) * (index - lowerIndex);
}

function summarizeResults(results) {
  const successes = results.filter((result) => result.success);
  const failures = results.length - successes.length;
  const cer = successes.map((result) => characterErrorRate(result.reference, result.transcript));
  const distance = cer.reduce((total, metric) => total + metric.distance, 0);
  const referenceChars = cer.reduce((total, metric) => total + metric.referenceChars, 0);
  const costs = results.map((result) => result.costCny).filter((value) => Number.isFinite(value));

  return {
    attempts: results.length,
    successes: successes.length,
    failures,
    failureRate: results.length ? failures / results.length : null,
    characterErrorRate: referenceChars
      ? { distance, referenceChars, rate: distance / referenceChars }
      : null,
    successfulLatencyMs: {
      p50: percentile(successes.map((result) => result.latencyMs), 0.5),
      p95: percentile(successes.map((result) => result.latencyMs), 0.95),
    },
    estimatedCostCny: costs.length ? costs.reduce((total, value) => total + value, 0) : null,
  };
}

export function summarizeProviderResults(results) {
  const byCategory = {};
  const categories = new Set(results.flatMap((result) => result.categories || []));

  for (const category of [...categories].sort()) {
    byCategory[category] = summarizeResults(results.filter((result) => result.categories?.includes(category)));
  }

  return { ...summarizeResults(results), byCategory };
}

export function validateBenchmarkManifest(manifest) {
  const samples = manifest?.samples;
  if (!Array.isArray(samples) || samples.length < MIN_SAMPLE_COUNT || samples.length > MAX_SAMPLE_COUNT) {
    throw new Error(`ASR benchmark manifest must contain ${MIN_SAMPLE_COUNT} to ${MAX_SAMPLE_COUNT} samples`);
  }

  const ids = new Set();
  for (const sample of samples) {
    const id = String(sample?.id || "").trim();
    if (!id || ids.has(id)) {
      throw new Error("Each ASR benchmark sample needs a unique id");
    }
    ids.add(id);

    if (!String(sample?.audioPath || "").trim() || !String(sample?.reference || "").trim()) {
      throw new Error(`ASR benchmark sample '${id}' needs audioPath and reference`);
    }
    if (!Array.isArray(sample?.categories) || sample.categories.length === 0 || sample.categories.some((value) => !String(value || "").trim())) {
      throw new Error(`ASR benchmark sample '${id}' needs at least one category`);
    }
  }
}

function mimeTypeForAudioPath(audioPath) {
  switch (path.extname(audioPath).toLowerCase()) {
    case ".wav":
      return "audio/wav";
    case ".mp3":
      return "audio/mpeg";
    case ".ogg":
      return "audio/ogg";
    case ".m4a":
      return "audio/mp4";
    default:
      return "audio/webm";
  }
}

function resolveSampleCost(sample, provider) {
  const value = Number(sample?.costCny?.[provider]);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function buildProviderEnv(env, provider) {
  return {
    ...env,
    DUPSEARCH_TRANSCRIBE_PROVIDER: provider,
    ...(provider === "beacon-doubao" ? { DUPSEARCH_BEACON_DOUBAO_ASR_FALLBACK_TO_LOCAL: "false" } : {}),
  };
}

function reportSampleResult(result) {
  return {
    id: result.id,
    categories: result.categories,
    success: result.success,
    latencyMs: result.latencyMs,
    characterErrorRate: result.success ? characterErrorRate(result.reference, result.transcript) : null,
    costCny: result.costCny,
  };
}

export async function runAsrBenchmark({ manifest, manifestPath, providers, env = process.env }) {
  validateBenchmarkManifest(manifest);
  const rootDirectory = path.dirname(path.resolve(manifestPath));
  const report = {};

  for (const provider of providers) {
    const providerEnv = buildProviderEnv(env, provider);
    const results = [];

    for (const sample of manifest.samples) {
      const audioPath = path.resolve(rootDirectory, sample.audioPath);
      const startedAt = performance.now();
      try {
        const audio = await fs.readFile(audioPath);
        const response = await transcribeAudio({
          audioBase64: audio.toString("base64"),
          mimeType: mimeTypeForAudioPath(audioPath),
        }, providerEnv);
        results.push({
          id: sample.id,
          categories: sample.categories.map((category) => String(category).trim()),
          success: true,
          latencyMs: performance.now() - startedAt,
          reference: sample.reference,
          transcript: response.text,
          costCny: resolveSampleCost(sample, provider),
        });
      } catch {
        results.push({
          id: sample.id,
          categories: sample.categories.map((category) => String(category).trim()),
          success: false,
          latencyMs: performance.now() - startedAt,
          reference: "",
          transcript: "",
          costCny: resolveSampleCost(sample, provider),
        });
      }
    }

    report[provider] = {
      summary: summarizeProviderResults(results),
      samples: results.map(reportSampleResult),
    };
  }

  return {
    generatedAt: new Date().toISOString(),
    sampleCount: manifest.samples.length,
    providers: report,
  };
}

function parseArguments(argv) {
  const options = { manifest: "", output: "", providers: ["local-funasr", "beacon-doubao"] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--manifest") {
      options.manifest = String(argv[index + 1] || "");
      index += 1;
    } else if (value === "--output") {
      options.output = String(argv[index + 1] || "");
      index += 1;
    } else if (value === "--providers") {
      options.providers = String(argv[index + 1] || "").split(",").map((provider) => provider.trim()).filter(Boolean);
      index += 1;
    }
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options.manifest || !options.output || !options.providers.length) {
    throw new Error("Usage: npm run benchmark:asr -- --manifest <manifest.json> --output <report.json> [--providers local-funasr,beacon-doubao]");
  }

  loadLocalEnv();
  const manifestPath = path.resolve(options.manifest);
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const report = await runAsrBenchmark({ manifest, manifestPath, providers: options.providers });
  const outputPath = path.resolve(options.output);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ outputPath, sampleCount: report.sampleCount, providers: Object.keys(report.providers) }));
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}