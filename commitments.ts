// commitments.ts — the commitments primitive (COMMITMENTS_DESIGN_v1).
//
// A commitment is ONE row keyed on (owner, about) carrying a `status`. This is the structural fix
// for current-state-after-reversal: instead of a commitment fact ("X committed to Y") that
// accumulates and is never superseded, plus a reversal that lands on a different subject, a reversal
// flips THIS row's status — so the live state is always correct, keyed consistently.
//
// status carries the lifecycle (open|fulfilled|broken|cancelled); valid_until stays NULL while the
// commitment is the current record and is closed only on supersession (renegotiation). So a broken
// or fulfilled commitment is still the CURRENT record — recall reads its status directly (resolves
// COMMITMENTS_DESIGN_v1 §9 Q3: status field, not a separate fulfilled_at/valid_until close).
import type { Db } from "./db";

export interface NewCommitment {
  ownerId: number;
  recipientId?: number | null;
  aboutId?: number | null;
  action: string;
  dueAt?: string | null;
  modality?: string;
  validFrom: string;
  sourceInteractionId: number;
  sourceSpan?: string | null;
  sourceChunkId?: number | null;
}

export interface Reversal {
  ownerId: number;
  aboutId?: number | null;
  status: "fulfilled" | "broken" | "cancelled";
  at: string;
  sourceInteractionId: number;
  sourceSpan?: string | null;
}

export interface CommitmentRow {
  id: number;
  status: string;
  valid_until: string | null;
}

// Create an OPEN commitment. status-provenance starts at the creation itself.
export async function createCommitment(db: Db, c: NewCommitment): Promise<number> {
  const r = await db.query<{ id: number }>(
    `insert into commitments
       (owner_id, recipient_id, about_id, action, due_at, modality, status,
        valid_from, source_interaction_id, source_span, source_chunk_id,
        status_at, status_source_interaction_id, status_source_span)
     values ($1, $2, $3, $4, $5, $6, 'open', $7, $8, $9, $10, $7, $8, $9)
     returning id`,
    [c.ownerId, c.recipientId ?? null, c.aboutId ?? null, c.action, c.dueAt ?? null,
     c.modality ?? "promise", c.validFrom, c.sourceInteractionId, c.sourceSpan ?? null,
     c.sourceChunkId ?? null]);
  return r.rows[0].id;
}

// The current (non-superseded) commitment for an (owner, about) pair, or null.
export async function currentCommitmentFor(
  db: Db, ownerId: number, aboutId: number | null,
): Promise<CommitmentRow | null> {
  const r = await db.query<CommitmentRow>(
    `select id, status, valid_until from commitments
      where owner_id = $1
        and (about_id = $2 or ($2 is null and about_id is null))
        and valid_until is null
      order by valid_from desc, id desc
      limit 1`,
    [ownerId, aboutId]);
  return r.rows[0] ?? null;
}

export interface CommitmentVerdict {
  answer: "yes" | "no";
  anchor: string;
  source_occurred_at: string;
  status: string;
}

// The current commitment's verdict for an (owner, about) pair: yes if it still stands
// (open/fulfilled), no if it's broken/cancelled — anchored to the source of the CURRENT status
// (the reversal, once one has flipped it).
export async function commitmentVerdict(
  db: Db, ownerId: number, aboutId: number | null,
): Promise<CommitmentVerdict | null> {
  const r = await db.query<{ status: string; anchor: string | null; occurred: any }>(
    `select c.status,
            i.content      as anchor,
            i.occurred_at  as occurred
       from commitments c
       left join interactions i on i.id = c.status_source_interaction_id
      where c.owner_id = $1
        and (c.about_id = $2 or ($2 is null and c.about_id is null))
        and c.valid_until is null
      order by c.valid_from desc, c.id desc
      limit 1`,
    [ownerId, aboutId]);
  const row = r.rows[0];
  if (!row) return null;
  const answer = (row.status === "open" || row.status === "fulfilled") ? "yes" : "no";
  return {
    answer,
    anchor: row.anchor ?? "",
    source_occurred_at: row.occurred instanceof Date ? row.occurred.toISOString() : new Date(row.occurred).toISOString(),
    status: row.status,
  };
}

export interface OpenCommitment {
  id: number;
  owner: string;
  about: string | null;
  action: string;
  due_at: string | null;
  status: string;
}

// Open, confirmed commitments TO a recipient — the "what did we promise Acme, and by when?" query
// the recipient FK exists to answer. Soonest-due first (overdue surfaces first), undated last.
export async function commitmentsTo(db: Db, recipientId: number): Promise<OpenCommitment[]> {
  const r = await db.query<any>(
    `select c.id, o.label as owner, ab.label as about, c.action, c.due_at, c.status
       from commitments c
       join entities o on o.id = c.owner_id
       left join entities ab on ab.id = c.about_id
      where c.recipient_id = $1 and c.valid_until is null
        and c.qa_status = 'confirmed' and c.status = 'open'
      order by c.due_at asc nulls last, c.id asc`, [recipientId]);
  return r.rows.map((row) => ({
    id: row.id, owner: row.owner, about: row.about ?? null, action: row.action,
    due_at: row.due_at ? (row.due_at instanceof Date ? row.due_at.toISOString() : new Date(row.due_at).toISOString()) : null,
    status: row.status,
  }));
}

// A reversal flips the matching current commitment's status (open → broken/fulfilled/cancelled),
// on the SAME row, and RE-ANCHORS the status provenance to the reversal's own interaction so recall
// cites the reversal ("can't make it"), not the original promise. Returns true if one matched.
export async function applyReversal(db: Db, rev: Reversal): Promise<boolean> {
  const r = await db.query<{ id: number }>(
    `update commitments
        set status = $3, status_at = $4, status_source_interaction_id = $5, status_source_span = $6
      where id = (
        select id from commitments
         where owner_id = $1
           and (about_id = $2 or ($2 is null and about_id is null))
           and valid_until is null
         order by valid_from desc, id desc
         limit 1)
      returning id`,
    [rev.ownerId, rev.aboutId ?? null, rev.status, rev.at, rev.sourceInteractionId, rev.sourceSpan ?? null]);
  return r.rows.length > 0;
}
