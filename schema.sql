-- Mnemon_OS — schema (Phase 0, thin)
-- Clean-room: built from the architecture (MNEMON_OS_v7 §6/§7, SYNAPSIS_SPEC_v2,
-- HONEST_EMPTY_SPEC_v2). No code from any prior engine. Postgres + pgvector / PGLite.
--
-- Five tables. The moat lives in `facts` (bi-temporal) and in the FTS index on
-- `interactions` (the honest-empty arbiter). Embedding dim = 384 (bge-small class);
-- swap the dim if the embedder changes — the verbatim is canonical, vectors rebuild.

create extension if not exists vector;

-- 1. interactions — the verbatim record (the truth-line). Append-only; never edited.
create table if not exists interactions (
  id           bigserial primary key,
  content      text        not null,                 -- verbatim, as said
  speaker      text,                                 -- free-form; nullable
  occurred_at  timestamptz not null,                 -- when it happened (from transcript) — drives bi-temporal
  ingested_at  timestamptz not null default now(),
  embedding    vector(384)                           -- local embedder; the vector half of hybrid recall
);

-- 1b. chunks — the L0 retrieval unit: a verbatim turn split into ~800-char windows (turn-aware).
-- The floor everything else stands on; indexed keyword + vector so recall works with no clean subject.
create table if not exists chunks (
  id             bigserial   primary key,
  interaction_id bigint      not null references interactions(id),
  ord            int         not null default 0,        -- order within the interaction
  content        text        not null,                  -- the chunk text (verbatim)
  embedding      vector(384),                           -- local embedder; the vector half of L0 recall
  created_at     timestamptz not null default now()
);

-- 2. entities — generic nodes (person/org/project/task/event/decision/fact/note/question + free labels).
create table if not exists entities (
  id          bigserial primary key,
  type        text        not null,                  -- core type (no domain branching)
  label       text        not null,                  -- display name
  slug        text        unique,                    -- stable canonical slug (consolidation canonicalization)
  created_at  timestamptz not null default now()
);

-- 2b. entity_aliases — remembered spelling/wording variants that resolve to one entity.
-- When fuzzy matching (typo) or semantic matching (reworded) is QA-confirmed as the same
-- entity, the variant is recorded here so the next mention resolves by cheap lookup, never
-- re-litigated. `norm` is the normalized key (lower/trim/collapsed) and is unique.
create table if not exists entity_aliases (
  id          bigserial   primary key,
  entity_id   bigint      not null references entities(id),
  alias       text        not null,                  -- the variant as seen (display)
  norm        text        not null,                  -- normalized key for matching
  created_at  timestamptz not null default now()
);

-- 3. facts — the bi-temporal heart. subject—predicate—object, validity-windowed.
create table if not exists facts (
  id                    bigserial   primary key,
  subject_id            bigint      not null references entities(id),
  predicate             text        not null,
  object_entity_id      bigint      references entities(id),    -- object as entity, OR
  object_literal        text,                                  -- object as literal/value
  shape                 text        not null default 'single', -- 'single' | 'multi' (fact-shape → contradiction policy)
  valid_from            timestamptz not null,                  -- when this became true
  valid_until           timestamptz,                           -- NULL = still current  ← the "current-state" filter
  superseded_by         bigint      references facts(id),       -- the fact that replaced this one
  -- provenance: every fact resolves to a source span (honest-empty rests on this).
  source_interaction_id bigint      not null references interactions(id),
  source_span           text,                                  -- the exact words this fact came from
  source_chunk_id       bigint      references chunks(id),     -- finer provenance: the chunk (interaction stays the stable anchor)
  source_hash           text,                                  -- hash of the source span → drift detection (E2 QA)
  status                text        not null default 'confirmed', -- 'provisional'|'confirmed'|'quarantined' (E2 flips default → 'provisional')
  confidence            real        not null default 1.0,
  embedding             vector(384),                           -- E3: fact embedding for cross-subject contradiction candidates
  created_at            timestamptz not null default now()
);

-- 4. diary — the read-small tier (today + ~3 days). Read whole, no retrieval.
create table if not exists diary (
  id          bigserial   primary key,
  entry_date  date        not null,
  content     text        not null,
  created_at  timestamptz not null default now()
);

-- 5. doc_index — authored wiki docs joined into the SAME shared retrieval.
create table if not exists doc_index (
  id          bigserial   primary key,
  slug        text        unique not null,
  title       text        not null,
  path        text        not null,                  -- file location (navigate-and-read)
  content     text,                                  -- indexed body
  embedding   vector(384),
  updated_at  timestamptz not null default now()
);

-- Indexes ---------------------------------------------------------------------

-- Honest-empty arbiter: embedding-free, recall-complete keyword scan over the verbatim.
-- If a term is in no interaction, it genuinely isn't in the source.
create index if not exists interactions_fts on interactions using gin (to_tsvector('english', content));

-- Semantic recall over the verbatim (the paraphrase side).
create index if not exists interactions_vec on interactions using hnsw (embedding vector_cosine_ops);

-- Contradiction lookup (find the open fact in the same slot) + current-state filter.
create index if not exists facts_slot     on facts (subject_id, predicate);
create index if not exists facts_current  on facts (subject_id, predicate) where valid_until is null;

-- recall_as_of windowing.
create index if not exists facts_validity on facts (valid_from, valid_until);

-- L0 chunk retrieval: keyword + vector over the chunked verbatim (the floor).
create index if not exists chunks_fts on chunks using gin (to_tsvector('english', content));
create index if not exists chunks_vec on chunks using hnsw (embedding vector_cosine_ops);
create index if not exists chunks_interaction on chunks (interaction_id);

-- Alias resolution: one normalized variant maps to exactly one entity.
create unique index if not exists entity_aliases_norm   on entity_aliases (norm);
create index        if not exists entity_aliases_entity on entity_aliases (entity_id);

-- Forward-compat for existing file-backed stores (no-op on fresh DBs; ALTERs run after chunks exists).
alter table facts add column if not exists source_chunk_id bigint references chunks(id);
alter table facts add column if not exists source_hash text;
alter table facts add column if not exists status text not null default 'confirmed';
alter table facts add column if not exists embedding vector(384);
create index if not exists facts_vec on facts using hnsw (embedding vector_cosine_ops);
