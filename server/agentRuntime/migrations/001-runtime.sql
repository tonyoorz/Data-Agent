BEGIN IMMEDIATE;

CREATE TABLE IF NOT EXISTS agent_schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_saver_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_threads (
  thread_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  parent_thread_id TEXT REFERENCES agent_threads(thread_id),
  parent_run_id TEXT,
  parent_checkpoint_id TEXT,
  supersedes_message_id TEXT,
  title TEXT NOT NULL DEFAULT '新对话',
  thread_version INTEGER NOT NULL DEFAULT 0 CHECK (thread_version >= 0),
  scope_version TEXT NOT NULL,
  scope_hash TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS agent_threads_actor_updated ON agent_threads(actor_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_runs (
  run_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES agent_threads(thread_id),
  actor_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  parent_run_id TEXT REFERENCES agent_runs(run_id),
  parent_checkpoint_id TEXT,
  request_hash TEXT NOT NULL,
  graph_definition_version TEXT NOT NULL,
  runtime_mode TEXT NOT NULL CHECK (runtime_mode IN ('legacy','shadow','langgraph')),
  status TEXT NOT NULL CHECK (status IN ('queued','running','waiting_for_clarification','waiting_for_approval','completed','failed','cancelled')),
  state_version INTEGER NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  lease_epoch INTEGER NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  lease_owner TEXT,
  lease_expires_at TEXT,
  requested_model_id TEXT NOT NULL,
  actual_model_id TEXT NOT NULL,
  model_config_version TEXT NOT NULL,
  scope_version TEXT NOT NULL,
  scope_hash TEXT NOT NULL,
  canonical_checkpoint_id TEXT,
  canonical_state_hash TEXT,
  active_execution_budget_ms INTEGER NOT NULL,
  active_execution_consumed_ms INTEGER NOT NULL DEFAULT 0,
  active_segment_started_at TEXT,
  hard_expires_at TEXT NOT NULL,
  cancel_requested_at TEXT,
  answer_json TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT,
  UNIQUE(actor_id, message_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_one_active_per_thread
  ON agent_runs(thread_id)
  WHERE status IN ('queued','running','waiting_for_clarification','waiting_for_approval');
CREATE INDEX IF NOT EXISTS agent_runs_reaper ON agent_runs(status, lease_expires_at, hard_expires_at);

CREATE TABLE IF NOT EXISTS agent_messages (
  message_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES agent_threads(thread_id),
  run_id TEXT REFERENCES agent_runs(run_id),
  parent_message_id TEXT,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','tool')),
  body_json TEXT NOT NULL,
  scope_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(thread_id, message_id)
);
CREATE INDEX IF NOT EXISTS agent_messages_thread_created ON agent_messages(thread_id, created_at);

CREATE TABLE IF NOT EXISTS agent_summaries (
  summary_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES agent_threads(thread_id),
  body_json TEXT NOT NULL,
  source_message_ids_json TEXT NOT NULL,
  semantic_frame_refs_json TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  summary_version TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  scope_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_model_turns (
  turn_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(run_id),
  invocation_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')),
  content_ref TEXT,
  content_hash TEXT,
  tool_call_id TEXT,
  tool_name TEXT,
  body_json TEXT NOT NULL DEFAULT '{}',
  scope_hash TEXT NOT NULL,
  graph_definition_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_model_turns_run_created ON agent_model_turns(run_id, created_at);

CREATE TABLE IF NOT EXISTS agent_interactions (
  interaction_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(run_id),
  kind TEXT NOT NULL CHECK (kind IN ('clarification','approval')),
  status TEXT NOT NULL CHECK (status IN ('pending','consumed','expired','cancelled')),
  payload_json TEXT NOT NULL,
  result_json TEXT,
  scope_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_interactions_one_pending_per_run
  ON agent_interactions(run_id) WHERE status='pending';

CREATE TABLE IF NOT EXISTS agent_step_journal (
  run_id TEXT NOT NULL REFERENCES agent_runs(run_id),
  node_id TEXT NOT NULL,
  logical_attempt INTEGER NOT NULL,
  input_hash TEXT NOT NULL,
  scope_hash TEXT NOT NULL,
  graph_definition_version TEXT NOT NULL,
  lease_epoch INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started','completed','failed','unknown')),
  result_json TEXT,
  error_json TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY(run_id, node_id, logical_attempt, input_hash)
);

CREATE TABLE IF NOT EXISTS agent_events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(run_id),
  thread_id TEXT NOT NULL REFERENCES agent_threads(thread_id),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  state_version INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  scope_hash TEXT NOT NULL,
  lease_epoch INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  published_at TEXT,
  UNIQUE(run_id, sequence)
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_events_one_terminal
  ON agent_events(run_id)
  WHERE event_type IN ('run.completed','run.failed','run.cancelled');

CREATE TABLE IF NOT EXISTS agent_event_tombstones (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  expired_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_artifact_blobs (
  content_hash TEXT PRIMARY KEY,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  storage_path TEXT NOT NULL,
  extraction_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_artifacts (
  artifact_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  workspace_scope_hash TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  content_hash TEXT NOT NULL REFERENCES agent_artifact_blobs(content_hash),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE(actor_id, content_hash)
);

CREATE TABLE IF NOT EXISTS agent_thread_artifacts (
  thread_id TEXT NOT NULL REFERENCES agent_threads(thread_id),
  artifact_id TEXT NOT NULL REFERENCES agent_artifacts(artifact_id),
  scope_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(thread_id, artifact_id)
);

CREATE TABLE IF NOT EXISTS agent_run_artifacts (
  run_id TEXT NOT NULL REFERENCES agent_runs(run_id),
  artifact_id TEXT NOT NULL REFERENCES agent_artifacts(artifact_id),
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(run_id, artifact_id)
);

CREATE TABLE IF NOT EXISTS agent_legacy_imports (
  actor_id TEXT NOT NULL,
  client_conversation_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  thread_id TEXT NOT NULL REFERENCES agent_threads(thread_id),
  created_at TEXT NOT NULL,
  PRIMARY KEY(actor_id, client_conversation_id)
);

CREATE TABLE IF NOT EXISTS agent_audit (
  audit_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  thread_id TEXT,
  run_id TEXT,
  action TEXT NOT NULL,
  scope_hash TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS agent_audit_no_update BEFORE UPDATE ON agent_audit
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_AUDIT'); END;

CREATE TABLE IF NOT EXISTS agent_actor_rate_limits (
  actor_id TEXT PRIMARY KEY,
  tokens REAL NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_instance_guard (
  guard_key TEXT PRIMARY KEY CHECK (guard_key='sqlite-single-instance'),
  owner_id TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL
);

INSERT OR IGNORE INTO agent_schema_migrations(version, applied_at)
VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));

COMMIT;