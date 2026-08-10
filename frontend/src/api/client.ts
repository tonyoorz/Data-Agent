/** Data-Agent API client */

import type { QueryResponse, MemoryStats, HistoryRecord } from '../types';
import { getAccessToken, refreshToken } from './auth';

const BASE = '/api/agent';

/** Attach auth header and handle token refresh on 401 */
async function authedFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const token = getAccessToken();
  const headers: Record<string, string> = {
    ...options.headers as Record<string, string>,
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  let res = await fetch(url, { ...options, headers });

  // Auto-refresh on 401
  if (res.status === 401) {
    const refreshed = await refreshToken();
    if (refreshed) {
      headers['Authorization'] = `Bearer ${refreshed.access_token}`;
      res = await fetch(url, { ...options, headers });
    }
  }

  return res;
}

export async function query(question: string, useMemory = true): Promise<QueryResponse> {
  const res = await authedFetch(`${BASE}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, use_memory: useMemory }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function sendFeedback(
  memoryId: string,
  feedback: 'up' | 'down',
  note = '',
  correction = '',
): Promise<{ success: boolean; feedback_id: string }> {
  const res = await authedFetch(`${BASE}/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query_memory_id: memoryId,
      feedback,
      note,
      correction,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function getStats(): Promise<MemoryStats> {
  const res = await authedFetch(`${BASE}/stats`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function getHistory(limit = 20): Promise<{ records: HistoryRecord[]; count: number }> {
  const res = await authedFetch(`${BASE}/history?limit=${limit}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * SSE stream query — returns an async generator of events
 */
export async function* streamQuery(question: string): AsyncGenerator<{ event: string; data: unknown }> {
  const url = `${BASE}/stream?question=${encodeURIComponent(question)}`;
  const res = await authedFetch(url);

  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = '';
  let currentData = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('event:')) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        currentData = line.slice(5).trim();
      } else if (line === '' && currentEvent) {
        let data: unknown = currentData;
        try {
          data = JSON.parse(currentData);
        } catch { /* keep as string */ }
        yield { event: currentEvent, data };
        currentEvent = '';
        currentData = '';
      }
    }
  }
}
