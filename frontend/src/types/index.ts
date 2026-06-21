/** Shared types for Data-Agent frontend */

export interface AgentStep {
  type: 'thought' | 'action' | 'observation' | 'final' | 'error';
  content: string;
  tool?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: unknown;
}

export interface DataStory {
  headline: string;
  body?: string;
  insights: string[];
  recommendation?: string;
  story_type: string;
}

export interface QueryResponse {
  success: boolean;
  answer: string;
  steps: AgentStep[];
  tools_used: string[];
  sql_executed: string[];
  story: DataStory | null;
  memory_record_id: string | null;
  total_time_ms: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  response?: QueryResponse;
  timestamp: number;
  feedback?: 'up' | 'down';
}

export interface MemoryStats {
  memory: {
    total_records: number;
    successful: number;
    success_rate: number;
    thumbs_up: number;
    thumbs_down: number;
    avg_score: number;
  };
  feedback: {
    total: number;
    thumbs_up: number;
    thumbs_down: number;
    satisfaction_rate: number;
    negative_notes: Array<{ question: string; note: string; correction: string }>;
  };
  weight_adjustments: Record<string, number>;
}

export interface HistoryRecord {
  id: string;
  question: string;
  sql: string;
  intent: string;
  result_summary: string;
  result_count: number;
  success: boolean;
  feedback: string | null;
  created_at: string;
  usage_count: number;
  score: number;
}
