// Typed client for /api/admin/stats/* endpoints.
const BASE = "/api/admin/stats";

async function http<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status}: ${text || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export interface OverviewData {
  rangeDays: number;
  chat: {
    total: number;
    success: number | null;
    errors: number | null;
    inputTokens: number;
    outputTokens: number;
    avgMs: number;
  };
  dedup: {
    total: number;
    success: number | null;
    avgMs: number;
  };
  daily: { day: string; chat_count: number; tokens: number; dedup_count: number }[];
  modelDistribution: { model: string; count: number; tokens: number }[];
}

export interface ChatQueryRow {
  id: number;
  requestId: string;
  model: string;
  queryPreview: string;
  queryLength: number;
  contextEnabled: boolean;
  status: string;
  errorMessage: string;
  totalMs: number;
  upstreamConnectMs: number;
  firstChunkMs: number;
  streamTotalMs: number;
  chunkCount: number;
  byteCount: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  notes: string;
  isValid: boolean;
  createdAt: number;
}

export interface PaginatedChatQueries {
  total: number;
  page: number;
  pageSize: number;
  rows: ChatQueryRow[];
}

export interface DedupSearchRow {
  id: number;
  queryText: string;
  topK: number;
  resultCount: number;
  summaryModel: string;
  summarySource: string;
  success: boolean;
  totalMs: number;
  errorMessage: string;
  notes: string;
  isValid: boolean;
  createdAt: number;
}

export interface PaginatedDedupSearches {
  total: number;
  page: number;
  pageSize: number;
  rows: DedupSearchRow[];
}

export interface TokenUsageData {
  rangeDays: number;
  daily: { day: string; input_tokens: number; output_tokens: number }[];
  byModel: {
    model: string;
    requests: number;
    input_tokens: number;
    output_tokens: number;
  }[];
}

export const adminApi = {
  getOverview: (days = 7) => http<OverviewData>(`${BASE}/overview?days=${days}`),
  getTokenUsage: (days = 30) => http<TokenUsageData>(`${BASE}/token-usage?days=${days}`),
  listChatQueries: (params: {
    page?: number;
    pageSize?: number;
    search?: string;
    status?: string;
    model?: string;
  } = {}) => {
    const q = new URLSearchParams();
    if (params.page) q.set("page", String(params.page));
    if (params.pageSize) q.set("pageSize", String(params.pageSize));
    if (params.search) q.set("search", params.search);
    if (params.status) q.set("status", params.status);
    if (params.model) q.set("model", params.model);
    return http<PaginatedChatQueries>(`${BASE}/chat-queries?${q.toString()}`);
  },
  getChatQuery: (id: number) => http<ChatQueryRow>(`${BASE}/chat-queries/${id}`),
  updateChatQuery: (id: number, body: { notes?: string; isValid?: boolean; status?: string }) =>
    http<{ success: boolean; row: ChatQueryRow }>(`${BASE}/chat-queries/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteChatQuery: (id: number) =>
    http<{ success: boolean }>(`${BASE}/chat-queries/${id}`, { method: "DELETE" }),
  batchChatQuery: (body: { ids: number[]; action: "delete" | "setValid"; isValid?: boolean }) =>
    http<{ success: boolean; affected: number }>(`${BASE}/chat-queries/batch`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  listDedupSearches: (params: {
    page?: number;
    pageSize?: number;
    search?: string;
    success?: string;
  } = {}) => {
    const q = new URLSearchParams();
    if (params.page) q.set("page", String(params.page));
    if (params.pageSize) q.set("pageSize", String(params.pageSize));
    if (params.search) q.set("search", params.search);
    if (params.success) q.set("success", params.success);
    return http<PaginatedDedupSearches>(`${BASE}/dedup-searches?${q.toString()}`);
  },
  updateDedupSearch: (id: number, body: { notes?: string; isValid?: boolean }) =>
    http<{ success: boolean; row: DedupSearchRow }>(`${BASE}/dedup-searches/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteDedupSearch: (id: number) =>
    http<{ success: boolean }>(`${BASE}/dedup-searches/${id}`, { method: "DELETE" }),
};
