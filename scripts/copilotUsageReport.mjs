function cloneValue(value) {
  if (Array.isArray(value)) {
    return value.map(cloneValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, cloneValue(nestedValue)]),
    );
  }

  return value;
}

const SHANGHAI_TIME_ZONE = "Asia/Shanghai";
const shanghaiDateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: SHANGHAI_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
const shanghaiDayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: SHANGHAI_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const shanghaiTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: SHANGHAI_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatShanghaiLocalDateTime(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "";
  }

  return shanghaiDateTimeFormatter.format(new Date(value)).replaceAll("/", "/");
}

function formatShanghaiDay(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "unknown";
  }

  return shanghaiDayFormatter.format(new Date(value));
}

function formatShanghaiTime(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "";
  }

  return shanghaiTimeFormatter.format(new Date(value));
}

function getShanghaiHour(value) {
  const time = formatShanghaiTime(value);
  return Number(time.slice(0, 2));
}

function isAfterHoursTimestamp(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return false;
  }

  const date = new Date(value);
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: SHANGHAI_TIME_ZONE,
    weekday: "short",
  }).format(date);
  const hour = getShanghaiHour(value);

  if (weekday === "Sat" || weekday === "Sun") {
    return true;
  }

  return hour < 9 || hour >= 18;
}

function ensureContainer(parent, key, nextKey) {
  if (parent[key] === undefined) {
    parent[key] = typeof nextKey === "number" ? [] : {};
  }

  return parent[key];
}

function applyPatch(target, keyPath, value) {
  if (!Array.isArray(keyPath) || keyPath.length === 0) {
    return cloneValue(value);
  }

  let cursor = target;

  for (let index = 0; index < keyPath.length - 1; index += 1) {
    const key = keyPath[index];
    const nextKey = keyPath[index + 1];

    if (typeof key === "number" && Array.isArray(cursor) && cursor[key] === undefined) {
      cursor[key] = typeof nextKey === "number" ? [] : {};
    }

    cursor = ensureContainer(cursor, key, nextKey);
  }

  cursor[keyPath[keyPath.length - 1]] = cloneValue(value);
  return target;
}

function toIsoString(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  return new Date(value).toISOString();
}

function sumBy(items, selector) {
  return items.reduce((total, item) => total + (selector(item) || 0), 0);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatInteger(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value || 0);
}

function formatCurrency(value) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value || 0);
}

function formatDurationMs(value) {
  const totalMs = value || 0;
  const totalSeconds = Math.floor(totalMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

function formatLocalDay(value) {
  if (!value) {
    return "unknown";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function estimateRecordCost(record) {
  const pricing = record.pricing || {};
  const inputCost = pricing.inputCost || 0;
  const outputCost = pricing.outputCost || 0;

  return ((record.promptTokens || 0) * inputCost + (record.outputTokens || 0) * outputCost) / 1_000_000;
}

function serializeJsonForHtml(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
}

export function parseChatSessionPatchLog(lines) {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error("Expected a non-empty JSONL patch log.");
  }

  let state = null;

  for (const rawLine of lines) {
    const entry = typeof rawLine === "string" ? JSON.parse(rawLine) : rawLine;

    if (entry.kind === 0) {
      state = cloneValue(entry.v);
      continue;
    }

    if (!state) {
      throw new Error("Patch log is missing the initial root snapshot.");
    }

    state = applyPatch(state, entry.k, entry.v);
  }

  const requests = Array.isArray(state?.requests) ? state.requests : [];
  const selectedModelState = state?.inputState?.selectedModel || {};
  const pricing = {
    inputCost: selectedModelState?.metadata?.inputCost || 0,
    outputCost: selectedModelState?.metadata?.outputCost || 0,
  };
  const usageEvents = requests
    .filter((request) => typeof request?.timestamp === "number" && Number.isFinite(request.timestamp))
    .map((request) => {
      const event = {
        timestamp: request.timestamp,
        model: selectedModelState?.identifier || "unknown",
        promptTokens: request?.result?.metadata?.promptTokens || 0,
        outputTokens: request?.result?.metadata?.outputTokens || 0,
        completionTokens: request?.completionTokens || 0,
        elapsedMs: request?.elapsedMs || request?.result?.timings?.totalElapsed || 0,
        pricing,
      };

      return {
        ...event,
        estimatedCost: estimateRecordCost(event),
        localTime: formatShanghaiLocalDateTime(request.timestamp),
        day: formatShanghaiDay(request.timestamp),
        timeOfDay: formatShanghaiTime(request.timestamp),
        isAfterHours: isAfterHoursTimestamp(request.timestamp),
      };
    });
  const timestamps = requests
    .map((request) => request?.timestamp)
    .filter((value) => typeof value === "number" && Number.isFinite(value));

  return {
    sessionId: state?.sessionId || "unknown",
    title: state?.customTitle || state?.title || state?.inputState?.inputText || "Untitled session",
    selectedModel: selectedModelState?.identifier || "unknown",
    pricing,
    requestCount: requests.length,
    promptTokens: sumBy(requests, (request) => request?.result?.metadata?.promptTokens || 0),
    outputTokens: sumBy(requests, (request) => request?.result?.metadata?.outputTokens || 0),
    completionTokens: sumBy(requests, (request) => request?.completionTokens || 0),
    elapsedMs: sumBy(requests, (request) => request?.elapsedMs || request?.result?.timings?.totalElapsed || 0),
    startedAt: toIsoString(Math.min(state?.creationDate || Infinity, ...timestamps)),
    updatedAt: toIsoString(Math.max(state?.creationDate || 0, ...timestamps)),
    usageEvents,
  };
}

export function aggregateUsageRecords(records) {
  const normalizedRecords = (records || []).map((record) => ({
    ...record,
    estimatedCost: estimateRecordCost(record),
  }));

  const totals = {
    sessionCount: normalizedRecords.length,
    requestCount: sumBy(normalizedRecords, (record) => record.requestCount),
    promptTokens: sumBy(normalizedRecords, (record) => record.promptTokens),
    outputTokens: sumBy(normalizedRecords, (record) => record.outputTokens),
    completionTokens: sumBy(normalizedRecords, (record) => record.completionTokens),
    elapsedMs: sumBy(normalizedRecords, (record) => record.elapsedMs),
    estimatedCost: sumBy(normalizedRecords, (record) => record.estimatedCost),
  };

  const modelMap = new Map();
  const dayMap = new Map();
  const usageEvents = normalizedRecords
    .flatMap((record) =>
      (record.usageEvents || []).map((event) => ({
        ...event,
        sessionId: record.sessionId,
        title: record.title,
      })),
    )
    .sort((left, right) => right.timestamp - left.timestamp);
  const afterHoursMap = new Map();

  for (const record of normalizedRecords) {
    const modelKey = record.selectedModel || "unknown";
    const dayKey = formatLocalDay(record.startedAt || record.updatedAt);

    if (!modelMap.has(modelKey)) {
      modelMap.set(modelKey, {
        model: modelKey,
        sessionCount: 0,
        requestCount: 0,
        promptTokens: 0,
        outputTokens: 0,
        completionTokens: 0,
        elapsedMs: 0,
        estimatedCost: 0,
      });
    }

    if (!dayMap.has(dayKey)) {
      dayMap.set(dayKey, {
        day: dayKey,
        sessionCount: 0,
        requestCount: 0,
        promptTokens: 0,
        outputTokens: 0,
        completionTokens: 0,
        elapsedMs: 0,
        estimatedCost: 0,
      });
    }

    for (const summary of [modelMap.get(modelKey), dayMap.get(dayKey)]) {
      summary.sessionCount += 1;
      summary.requestCount += record.requestCount || 0;
      summary.promptTokens += record.promptTokens || 0;
      summary.outputTokens += record.outputTokens || 0;
      summary.completionTokens += record.completionTokens || 0;
      summary.elapsedMs += record.elapsedMs || 0;
      summary.estimatedCost += record.estimatedCost || 0;
    }
  }

  for (const event of usageEvents.filter((item) => item.isAfterHours)) {
    if (!afterHoursMap.has(event.day)) {
      afterHoursMap.set(event.day, {
        day: event.day,
        requestCount: 0,
        elapsedMs: 0,
        firstLocalTime: event.localTime,
        lastLocalTime: event.localTime,
      });
    }

    const summary = afterHoursMap.get(event.day);
    summary.requestCount += 1;
    summary.elapsedMs += event.elapsedMs || 0;
    if (event.localTime < summary.firstLocalTime) {
      summary.firstLocalTime = event.localTime;
    }
    if (event.localTime > summary.lastLocalTime) {
      summary.lastLocalTime = event.localTime;
    }
  }

  const sortByCostDesc = (left, right) => right.estimatedCost - left.estimatedCost || right.promptTokens - left.promptTokens;
  const afterHoursEvents = usageEvents.filter((event) => event.isAfterHours);

  return {
    generatedAt: new Date().toISOString(),
    totals,
    byModel: [...modelMap.values()].sort(sortByCostDesc),
    byDay: [...dayMap.values()].sort((left, right) => left.day.localeCompare(right.day)),
    topSessions: [...normalizedRecords]
      .map((record) => ({
        sessionId: record.sessionId,
        title: record.title,
        model: record.selectedModel,
        startedAt: record.startedAt,
        updatedAt: record.updatedAt,
        requestCount: record.requestCount,
        promptTokens: record.promptTokens,
        outputTokens: record.outputTokens,
        completionTokens: record.completionTokens,
        elapsedMs: record.elapsedMs,
        estimatedCost: record.estimatedCost,
      }))
      .sort(sortByCostDesc)
      .slice(0, 100),
    usageEvents,
    afterHours: {
      requestCount: afterHoursEvents.length,
      elapsedMs: sumBy(afterHoursEvents, (event) => event.elapsedMs || 0),
      latestLocalTime: afterHoursEvents[0]?.localTime || "",
      byDay: [...afterHoursMap.values()]
        .sort((left, right) => right.elapsedMs - left.elapsedMs || right.requestCount - left.requestCount)
        .slice(0, 20),
    },
    warnings: [],
  };
}

function renderTotalsCards(totals) {
  const cards = [
    ["Sessions", formatInteger(totals.sessionCount)],
    ["Requests", formatInteger(totals.requestCount)],
    ["Prompt Tokens", formatInteger(totals.promptTokens)],
    ["Output Tokens", formatInteger(totals.outputTokens)],
    ["Elapsed Time", formatDurationMs(totals.elapsedMs)],
    ["Estimated Cost", `$${formatCurrency(totals.estimatedCost)}`],
  ];

  return cards
    .map(
      ([label, value]) => `
        <article class="card">
          <div class="card-label">${escapeHtml(label)}</div>
          <div class="card-value">${escapeHtml(value)}</div>
        </article>`,
    )
    .join("");
}

function renderTable(headers, rows) {
  return `
    <table>
      <thead>
        <tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr>
      </thead>
      <tbody>
        ${rows.join("")}
      </tbody>
    </table>`;
}

function renderAfterHoursSection(summary) {
  const rows = (summary.afterHours?.byDay || []).map(
    (row) => `
      <tr>
        <td>${escapeHtml(row.day)}</td>
        <td>${formatInteger(row.requestCount)}</td>
        <td>${formatDurationMs(row.elapsedMs)}</td>
        <td>${escapeHtml(row.firstLocalTime)}</td>
        <td>${escapeHtml(row.lastLocalTime)}</td>
      </tr>`,
  );

  return `
      <section>
        <div class="section-head">
          <div>
            <h2>After-hours</h2>
            <p>Computed in UTC+8. Workdays before 09:00 or after 18:00, plus weekends.</p>
          </div>
          <div class="section-metrics">
            <span>${formatInteger(summary.afterHours?.requestCount || 0)} events</span>
            <span>${formatDurationMs(summary.afterHours?.elapsedMs || 0)}</span>
            <span>${escapeHtml(summary.afterHours?.latestLocalTime || "")}</span>
          </div>
        </div>
        ${renderTable(["Day", "Events", "Elapsed", "First Event", "Last Event"], rows)}
      </section>`;
}

export function renderUsageReportHtml(summary) {
  const modelRows = summary.byModel.map(
    (row) => `
      <tr>
        <td>${escapeHtml(row.model)}</td>
        <td>${formatInteger(row.sessionCount)}</td>
        <td>${formatInteger(row.requestCount)}</td>
        <td>${formatInteger(row.promptTokens)}</td>
        <td>${formatInteger(row.outputTokens)}</td>
        <td>${formatDurationMs(row.elapsedMs)}</td>
        <td>$${formatCurrency(row.estimatedCost)}</td>
      </tr>`,
  );
  const dayRows = summary.byDay.map(
    (row) => `
      <tr>
        <td>${escapeHtml(row.day)}</td>
        <td>${formatInteger(row.sessionCount)}</td>
        <td>${formatInteger(row.requestCount)}</td>
        <td>${formatInteger(row.promptTokens)}</td>
        <td>${formatInteger(row.outputTokens)}</td>
        <td>$${formatCurrency(row.estimatedCost)}</td>
      </tr>`,
  );
  const sessionRows = summary.topSessions.map(
    (row) => `
      <tr>
        <td>${escapeHtml(row.title || row.sessionId)}</td>
        <td>${escapeHtml(row.model)}</td>
        <td>${escapeHtml(row.startedAt || "")}</td>
        <td>${escapeHtml(row.updatedAt || "")}</td>
        <td>${formatInteger(row.requestCount)}</td>
        <td>${formatInteger(row.promptTokens)}</td>
        <td>${formatInteger(row.outputTokens)}</td>
        <td>${formatDurationMs(row.elapsedMs)}</td>
        <td>$${formatCurrency(row.estimatedCost)}</td>
      </tr>`,
  );
  const warningsBlock = summary.warnings?.length
    ? `
      <section>
        <h2>Warnings</h2>
        <ul>
          ${summary.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}
        </ul>
      </section>`
    : "";
  const usageEventsJson = serializeJsonForHtml(summary.usageEvents || []);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Copilot Usage History</title>
    <style>
      :root {
        --bg: #f3efe6;
        --surface: rgba(255, 252, 247, 0.9);
        --ink: #1f1a16;
        --muted: #6e6258;
        --line: rgba(31, 26, 22, 0.14);
        --shadow: 0 20px 60px rgba(31, 26, 22, 0.12);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: Georgia, "Times New Roman", serif;
        color: var(--ink);
        background: linear-gradient(180deg, #f9f5ec 0%, var(--bg) 100%);
      }
      main {
        width: min(1200px, calc(100% - 32px));
        margin: 0 auto;
        padding: 48px 0 72px;
      }
      header {
        margin-bottom: 28px;
        padding: 28px;
        border: 1px solid var(--line);
        border-radius: 28px;
        background: var(--surface);
        box-shadow: var(--shadow);
      }
      h1, h2 { margin: 0; line-height: 1.1; }
      h1 { font-size: clamp(2.2rem, 5vw, 4.4rem); }
      h2 { font-size: 1.5rem; margin-bottom: 14px; }
      p { color: var(--muted); line-height: 1.6; }
      .cards {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
        gap: 14px;
        margin: 28px 0;
      }
      .card, section {
        border: 1px solid var(--line);
        border-radius: 24px;
        background: var(--surface);
        box-shadow: var(--shadow);
      }
      .card { padding: 18px; }
      .card-label { color: var(--muted); font-size: 0.95rem; }
      .card-value { margin-top: 10px; font-size: 1.8rem; font-weight: 700; }
      section { margin-top: 18px; padding: 22px; overflow: hidden; }
      .section-head {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        align-items: flex-end;
        margin-bottom: 14px;
      }
      .section-head p { margin: 8px 0 0; }
      .section-metrics {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        justify-content: flex-end;
        color: var(--muted);
        font-size: 0.92rem;
      }
      .section-metrics span {
        padding: 8px 12px;
        border: 1px solid var(--line);
        border-radius: 999px;
      }
      .filter-bar {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 12px;
        margin-bottom: 16px;
      }
      .filter-label {
        display: block;
        color: var(--muted);
        font-size: 0.82rem;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        margin-bottom: 6px;
      }
      .filter-control {
        width: 100%;
        padding: 10px 12px;
        border: 1px solid var(--line);
        border-radius: 12px;
        background: rgba(255,255,255,0.7);
        color: var(--ink);
      }
      .checkbox-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding-top: 24px;
      }
      .table-meta {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        color: var(--muted);
        font-size: 0.92rem;
        margin-bottom: 10px;
      }
      table { width: 100%; border-collapse: collapse; font-size: 0.95rem; }
      th, td { padding: 12px 10px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
      th { color: var(--muted); font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.06em; }
      tbody tr:last-child td { border-bottom: none; }
      .fine-print { margin-top: 20px; font-size: 0.92rem; }
      @media (max-width: 800px) {
        main { width: min(100% - 20px, 1200px); padding-top: 24px; }
        section { padding: 16px; }
        .section-head, .table-meta { display: block; }
        table { display: block; overflow-x: auto; }
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <p>Generated ${escapeHtml(summary.generatedAt)}</p>
        <h1>Copilot Usage History</h1>
        <p>Full retained local chat-session history across this machine, summarized into model usage, token volume, elapsed time, and estimated cost. All displayed event timestamps use UTC+8.</p>
      </header>
      <div class="cards">${renderTotalsCards(summary.totals)}</div>
      <section>
        <div class="section-head">
          <div>
            <h2>Usage Events</h2>
            <p>Simple event list in UTC+8. Filter by date range and time of day, for example activity after 18:00.</p>
          </div>
        </div>
        <div class="filter-bar">
          <label>
            <span class="filter-label">Start Date</span>
            <input id="start-date-filter" class="filter-control" type="date" />
          </label>
          <label>
            <span class="filter-label">End Date</span>
            <input id="end-date-filter" class="filter-control" type="date" />
          </label>
          <label>
            <span class="filter-label">After Time</span>
            <input id="after-time-filter" class="filter-control" type="time" value="18:00" />
          </label>
          <label class="checkbox-row">
            <input id="after-hours-only-filter" type="checkbox" />
            <span>Only after-hours</span>
          </label>
        </div>
        <div class="table-meta">
          <span id="usage-events-count"></span>
          <span>Columns: Time, Model, Cost, Prompt Tokens, Elapsed</span>
        </div>
        <table>
          <thead>
            <tr><th>Time (UTC+8)</th><th>Model</th><th>Estimated Cost</th><th>Prompt Tokens</th><th>Elapsed</th></tr>
          </thead>
          <tbody id="usage-events-body"></tbody>
        </table>
      </section>
      ${renderAfterHoursSection(summary)}
      <section>
        <h2>By Model</h2>
        ${renderTable(["Model", "Sessions", "Requests", "Prompt Tokens", "Output Tokens", "Elapsed", "Estimated Cost"], modelRows)}
      </section>
      <section>
        <h2>By Day</h2>
        ${renderTable(["Day", "Sessions", "Requests", "Prompt Tokens", "Output Tokens", "Estimated Cost"], dayRows)}
      </section>
      <section>
        <h2>Top Sessions</h2>
        ${renderTable(["Title", "Model", "Started", "Updated", "Requests", "Prompt Tokens", "Output Tokens", "Elapsed", "Estimated Cost"], sessionRows)}
      </section>
      <section>
        <h2>Methodology</h2>
        <p class="fine-print">Estimated Cost is derived from the pricing metadata stored inside retained local chat session files. This is a local reconstruction of retained history, not an official GitHub Copilot billing statement.</p>
      </section>
      ${warningsBlock}
    </main>
    <script id="usage-events-data" type="application/json">${usageEventsJson}</script>
    <script>
      const usageEvents = JSON.parse(document.getElementById("usage-events-data").textContent);
      const eventsBody = document.getElementById("usage-events-body");
      const countLabel = document.getElementById("usage-events-count");
      const startDateInput = document.getElementById("start-date-filter");
      const endDateInput = document.getElementById("end-date-filter");
      const afterTimeInput = document.getElementById("after-time-filter");
      const afterHoursOnlyInput = document.getElementById("after-hours-only-filter");

      function escapeText(value) {
        return String(value ?? "")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#39;");
      }

      function formatElapsed(ms) {
        const totalMs = Number(ms || 0);
        const totalSeconds = Math.floor(totalMs / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;

        if (hours > 0) {
          return hours + "h " + minutes + "m " + seconds + "s";
        }

        if (minutes > 0) {
          return minutes + "m " + seconds + "s";
        }

        return seconds + "s";
      }

      function renderUsageEvents() {
        const startDate = startDateInput.value;
        const endDate = endDateInput.value;
        const afterTime = afterTimeInput.value;
        const afterHoursOnly = afterHoursOnlyInput.checked;

        const filtered = usageEvents.filter((event) => {
          if (startDate && event.day < startDate) {
            return false;
          }
          if (endDate && event.day > endDate) {
            return false;
          }
          if (afterTime && event.timeOfDay < afterTime) {
            return false;
          }
          if (afterHoursOnly && !event.isAfterHours) {
            return false;
          }
          return true;
        });

        const limited = filtered.slice(0, 500);

        countLabel.textContent = limited.length + " events shown / " + usageEvents.length + " total timestamped events";
        eventsBody.innerHTML = limited.map((event) => {
          return "<tr>"
            + "<td>" + escapeText(event.localTime) + "</td>"
            + "<td>" + escapeText(event.model) + "</td>"
            + "<td>$" + Number(event.estimatedCost || 0).toFixed(4) + "</td>"
            + "<td>" + Number(event.promptTokens || 0).toLocaleString("en-US") + "</td>"
            + "<td>" + escapeText(formatElapsed(event.elapsedMs || 0)) + "</td>"
            + "</tr>";
        }).join("");
      }

      [startDateInput, endDateInput, afterTimeInput, afterHoursOnlyInput].forEach((input) => {
        input.addEventListener("input", renderUsageEvents);
        input.addEventListener("change", renderUsageEvents);
      });

      renderUsageEvents();
    </script>
  </body>
</html>`;
}