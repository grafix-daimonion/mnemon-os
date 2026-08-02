// Commitment System with Full Lifecycle Tracking
// Replaces the accumulating facts approach with proper status management
// Supports: open, fulfilled, broken, cancelled states with bi-temporal tracking

import type { PGlite } from "@electric-sql/pglite";

export interface Commitment {
  id: number;
  owner_entity_id: number;
  about_entity_id: number | null;
  action: string;
  normalized_action: string;
  status: 'open' | 'fulfilled' | 'broken' | 'cancelled';
  status_at: Date | null;
  valid_from: Date;
  valid_until: Date | null;
  source_interaction_id: number;
  source_span: string;
  scope_id: number | null;
}

// Create the commitments table
export const COMMITMENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS commitments (
  id BIGSERIAL PRIMARY KEY,
  owner_entity_id BIGINT NOT NULL REFERENCES entities(id),
  about_entity_id BIGINT REFERENCES entities(id),
  action TEXT NOT NULL,
  normalized_action TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  status_at TIMESTAMPTZ,
  valid_from TIMESTAMPTZ NOT NULL,
  valid_until TIMESTAMPTZ,
  source_interaction_id BIGINT NOT NULL REFERENCES interactions(id),
  source_span TEXT,
  scope_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Unique per commitment within scope
  CONSTRAINT commitments_unique_action
    UNIQUE(owner_entity_id, about_entity_id, normalized_action, scope_id)
);

CREATE INDEX IF NOT EXISTS commitments_owner ON commitments(owner_entity_id);
CREATE INDEX IF NOT EXISTS commitments_about ON commitments(about_entity_id);
CREATE INDEX IF NOT EXISTS commitments_scope ON commitments(scope_id);
CREATE INDEX IF NOT EXISTS commitments_status ON commitments(status);
`;

// Find or create a commitment
export async function findOrCreateCommitment(
  db: PGlite,
  ownerId: number,
  aboutId: number | null,
  action: string,
  sourceInteractionId: number,
  sourceSpan: string,
  scopeId: number | null = null
): Promise<Commitment> {
  const normalizedAction = normalizeAction(action);

  // Check for existing commitment (deduplication)
  const existing = await db.query<Commitment>(
    `SELECT c.* FROM commitments c
     WHERE c.owner_entity_id = $1
       AND c.about_entity_id IS NOT DISTINCT FROM $2
       AND c.normalized_action = $3
       AND c.scope_id IS NOT DISTINCT FROM $4
       AND c.valid_until IS NULL`,
    [ownerId, aboutId, normalizedAction, scopeId]
  );

  if (existing.rows[0]) {
    return existing.rows[0];
  }

  // Create new commitment
  const result = await db.query<Commitment>(
    `INSERT INTO commitments (
       owner_entity_id, about_entity_id, action, normalized_action,
       status, valid_from, source_interaction_id, source_span, scope_id
     ) VALUES ($1, $2, $3, $4, 'open', NOW(), $5, $6, $7)
     RETURNING *`,
    [ownerId, aboutId, action, normalizedAction,
     sourceInteractionId, sourceSpan, scopeId]
  );

  return result.rows[0];
}

// Update commitment status (reversal)
export async function updateCommitmentStatus(
  db: PGlite,
  commitmentId: number,
  newStatus: 'fulfilled' | 'broken' | 'cancelled',
  sourceInteractionId: number
): Promise<void> {
  await db.query(
    `UPDATE commitments
     SET status = $1,
         status_at = NOW()
     WHERE id = $2`,
    [newStatus, commitmentId]
  );

  // Log the status change in interactions for audit
  await logStatusChange(db, commitmentId, newStatus, sourceInteractionId);
}

// Get commitment status at a specific time (bi-temporal)
export function getCommitmentStatusAsOf(
  commitment: Commitment,
  asOf: Date | null = null
): string {
  if (!asOf) {
    return commitment.status; // Current status
  }

  if (commitment.status_at && asOf < commitment.status_at) {
    return 'open'; // Before any status change
  }

  return commitment.status; // After status change
}

// Find commitments by owner within scope
export async function findCommitmentsByOwner(
  db: PGlite,
  ownerId: number,
  status?: string,
  scopeId: number | null = null
): Promise<Commitment[]> {
  let query = `
    SELECT c.* FROM commitments c
    WHERE c.owner_entity_id = $1
      AND c.scope_id IS NOT DISTINCT FROM $2
      AND c.valid_until IS NULL`;

  const params: any[] = [ownerId, scopeId];

  if (status) {
    query += ` AND c.status = $3`;
    params.push(status);
  }

  query += ` ORDER BY c.valid_from DESC`;

  const result = await db.query<Commitment>(query, params);
  return result.rows;
}

// Find commitments about a subject within scope
export async function findCommitmentsAbout(
  db: PGlite,
  aboutId: number,
  status?: string,
  scopeId: number | null = null
): Promise<Commitment[]> {
  let query = `
    SELECT c.* FROM commitments c
    WHERE c.about_entity_id = $1
      AND c.scope_id IS NOT DISTINCT FROM $2
      AND c.valid_until IS NULL`;

  const params: any[] = [aboutId, scopeId];

  if (status) {
    query += ` AND c.status = $3`;
    params.push(status);
  }

  query += ` ORDER BY c.valid_from DESC`;

  const result = await db.query<Commitment>(query, params);
  return result.rows;
}

// Get all open commitments within scope
export async function getOpenCommitments(
  db: PGlite,
  scopeId: number | null = null
): Promise<Commitment[]> {
  const result = await db.query<Commitment>(
    `SELECT c.* FROM commitments c
     WHERE c.status = 'open'
       AND c.scope_id IS NOT DISTINCT FROM $1
       AND c.valid_until IS NULL
     ORDER BY c.valid_from`,
    [scopeId]
  );

  return result.rows;
}

// Normalize action for deduplication
function normalizeAction(action: string): string {
  return action
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Log status changes for audit
async function logStatusChange(
  db: PGlite,
  commitmentId: number,
  newStatus: string,
  sourceInteractionId: number
): Promise<void> {
  // This could be enhanced to create audit log entries
  // For now, the status_at timestamp tracks when it changed
  console.log(`Commitment ${commitmentId} status changed to ${newStatus} via interaction ${sourceInteractionId}`);
}

// Mark commitment as superseded (for renegotiation)
export async function supersedeCommitment(
  db: PGlite,
  oldCommitmentId: number,
  newCommitmentId: number
): Promise<void> {
  await db.query(
    `UPDATE commitments
     SET valid_until = NOW()
     WHERE id = $1`,
    [oldCommitmentId]
  );
}