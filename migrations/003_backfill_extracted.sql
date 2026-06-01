-- 003_backfill_extracted: mark pre-Z2 chunks as already-extracted.
-- Per DECOUPLING_IMPL_SPEC_v2 §9 row 003.
--
-- All chunks that existed before the v2-decoupling cutover were processed by the
-- old inline pipeline (pipeline.ts ingest). We don't want Z2 to re-extract them
-- (re_extract is opt-in). This migration is a ONE-SHOT backfill — the
-- schema_migrations runner ensures it runs exactly once. After Z2 ships, new
-- chunks created via archive_turn start at DEFAULT 'pending' and Z2 picks them up.
--
-- Safe to be a bare UPDATE: the runner gates it on first run only.

UPDATE chunks
   SET extraction_status = 'extracted'
 WHERE extraction_status = 'pending';
