-- 002_synapsis_runs: observability for Z1 capture + Z2 extraction runs.
-- Per DECOUPLING_IMPL_SPEC_v2 §4.2.
--
-- One row per stage execution (Z1 'capture' on /save; Z2 'extract' per batch).
-- run_id is what archive_turn returns so the caller can correlate observability.

CREATE TABLE IF NOT EXISTS synapsis_runs (
  id             bigserial PRIMARY KEY,
  interaction_id bigint REFERENCES interactions(id),
  stage          text NOT NULL CHECK (stage IN ('capture', 'extract')),
  status         text NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  chunks_total   int  NOT NULL DEFAULT 0,
  chunks_ok      int  NOT NULL DEFAULT 0,
  chunks_failed  int  NOT NULL DEFAULT 0,
  started_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz
);

CREATE INDEX IF NOT EXISTS synapsis_runs_interaction
  ON synapsis_runs (interaction_id);

CREATE INDEX IF NOT EXISTS synapsis_runs_running
  ON synapsis_runs (id) WHERE status = 'running';
