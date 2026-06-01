-- 001_extraction_status: add chunks.extraction_status state machine + claim-scan index.
-- Per DECOUPLING_IMPL_SPEC_v2 §4.1.
--
-- States:
--   'pending'     — Z1 captured, Z2 not done yet
--   'extracted'   — Z2 ran successfully (0+ facts; QA passed)
--   'quarantined' — Z2 ran, all facts failed faithfulness QA
--
-- chunks_pending is a partial index covering only the Z2 worker's claim scan
-- (FOR UPDATE SKIP LOCKED), so writes to extracted/quarantined chunks don't
-- bloat it.
--
-- Note on idempotency: this migration is gated by the schema_migrations runner
-- (db.ts), so the column-add + constraint-add execute exactly once. Re-applying
-- under the runner is a no-op. The defensive IF NOT EXISTS clauses make the file
-- safe to apply manually too.

ALTER TABLE chunks
  ADD COLUMN IF NOT EXISTS extraction_status text NOT NULL DEFAULT 'pending';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chunks_extraction_status_check'
  ) THEN
    ALTER TABLE chunks
      ADD CONSTRAINT chunks_extraction_status_check
      CHECK (extraction_status IN ('pending', 'extracted', 'quarantined'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS chunks_pending
  ON chunks (id) WHERE extraction_status = 'pending';
