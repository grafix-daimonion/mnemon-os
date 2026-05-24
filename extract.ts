// extract.ts — context-aware extraction. Before the model writes anything, it is shown
// what's already in the graph (entities + predicates) and the account this conversation is
// about. It REUSES existing names/labels instead of minting near-duplicates, and CONNECTS
// dependent things (projects, deadlines, initiatives) to their owner — so the graph stays
// joined and updates land on the same node (which is what lets supersession fire).
import { llmJSON } from "./llm.ts";
import { logEvent } from "./logger.ts";

export interface ExtractedFact {
  subject: string;
  subject_type: string;            // person | org | project | event | thing
  predicate: string;
  object: string;
  object_kind: "entity" | "literal";
  object_type?: string;
  shape: "single" | "multi";
  source_span: string;
}

export interface ExtractContext {
  entities: { label: string; type: string }[];
  predicates: string[];
  account: string | null;
}

const SYSTEM = `You extract durable facts from one note for a memory system. Return JSON {facts:[...]}.
You are given CONTEXT — use it so the graph stays consistent:
- known_entities: entities already stored (name + type). If the note refers to one of these, REUSE
  the exact name. Do NOT create a near-duplicate ("SSO rollout" vs "the SSO project").
- known_predicates: relationship labels already used. Reuse one when the relationship is the same,
  even if the note words it differently.
- account: the customer/account this conversation is about (may be null).

Each fact = subject — predicate — object:
- subject: prefer the PERSON or ORG responsible. If someone commits to / reports something, the
  subject is that person, not the thing reported.
- DEPENDENT entities (project, initiative, deadline, meeting, ticket — things that only exist relative
  to an owner) must be CONNECTED. When the note is about one, ALSO emit a linking fact:
  {subject:<account or responsible org/person>, predicate:"has", object:<dependent entity>, object_kind:"entity", object_type:<kind>, shape:"multi"}.
  Default the owner to the account unless the note clearly says otherwise.
- Put a CHANGING property (a date, a status) ON the dependent entity itself
  (e.g. "SSO rollout" —target date→ "Q2"), so a later update to it supersedes cleanly.
- A fact MUST be self-contained — it must carry WHAT it is about. An assessment / status / risk is
  always ABOUT a specific thing: make that thing the SUBJECT, with the referent intact, and link the
  person separately. E.g. "Bob won't finish the API migration on time" →
  {subject:"API migration", predicate:"completion status", object:"won't finish on time", shape:"single"}
  PLUS {subject:"Bob", predicate:"responsible for", object:"API migration", object_kind:"entity"}.
  NEVER emit a bare status on a person with no referent — "Bob | status | at risk" is INVALID
  (at risk of WHAT?). Keep the same SUBJECT across a commitment and its later status, so the update
  supersedes the original.
- predicate: a stable, stance-free label; reuse a known_predicate when it fits.
- object + object_kind: another node ("entity", give object_type) OR a value/stance ("literal").
- shape: "single" (one value at a time: a status/date/role) or "multi" (accumulates: a list).
- source_span: the exact substring supporting the fact.
If no durable fact, return {facts:[]}.`;

export async function extractFacts(
  content: string,
  speaker: string | null,
  interactionId: number,
  ctx?: ExtractContext,
): Promise<ExtractedFact[]> {
  const context = ctx ?? { entities: [], predicates: [], account: null };
  const user = JSON.stringify({
    account: context.account,
    known_entities: context.entities,
    known_predicates: context.predicates,
    note: `${speaker ? speaker + ": " : ""}${content}`,
  });
  const out = await llmJSON(SYSTEM, user);
  const facts: ExtractedFact[] = Array.isArray(out?.facts) ? out.facts : [];
  logEvent("extract", { interaction_id: interactionId, content, account: context.account, facts });
  return facts;
}
