// extract.ts — context-aware extraction. Before the model writes anything, it is shown
// what's already in the graph (entities + predicates) and the account this conversation is
// about. It REUSES existing names/labels instead of minting near-duplicates, and CONNECTS
// dependent things (projects, deadlines, initiatives) to their owner — so the graph stays
// joined and updates land on the same node (which is what lets supersession fire).
import { llmJSON } from "./llm.ts";
import { logEvent } from "./logger.ts";

export interface ExtractedFact {
  subject: string;
  subject_type: string;            // Person:Human | Persona:AI | org | project | event | thing
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
  owner?: string | null;        // the human Owner of this memory → always Person:Human (Lock 2)
  ai_personas?: string[];       // names that are AI agents/personas → always Persona:AI (Lock 4)
}

// A directed obligation: "owner will do action (about thing, to recipient, by due)". Routed to the
// commitments table, NOT the facts triple — the triple can't hold recipient/time/modality, and a
// reversal must flip ONE row's status rather than fight the accumulate-vs-supersede rule of facts.
export interface ExtractedCommitment {
  owner: string;
  owner_type?: string;
  recipient?: string | null;
  recipient_type?: string;
  about?: string | null;
  about_type?: string;
  action: string;
  due?: string | null;
  modality?: string;
  source_span: string;
}

// A later statement that an EARLIER commitment is now broken / fulfilled / cancelled.
export interface ExtractedReversal {
  owner: string;
  about?: string | null;
  status: "fulfilled" | "broken" | "cancelled";
  source_span: string;
}

export interface ExtractResult {
  facts: ExtractedFact[];
  commitments: ExtractedCommitment[];
  reversals: ExtractedReversal[];
}

const SYSTEM = `You extract durable facts from one note for a memory system. Return JSON {facts:[...]}.
You are given CONTEXT — use it so the graph stays consistent:
- known_entities: entities already stored (name + type). If the note refers to one of these, REUSE
  the exact name. Do NOT create a near-duplicate ("SSO rollout" vs "the SSO project").
- known_predicates: relationship labels already used. Reuse one when the relationship is the same,
  even if the note words it differently.
- account: the customer/account this conversation is about (may be null).
- owner: the human who owns this memory. The owner is ALWAYS kind Person:Human — never org/thing.
- ai_personas: names that are AI agents/assistants/personas. Each is ALWAYS kind Persona:AI.

ENTITY KIND (subject_type / object_type) — use these canonical kinds, most specific that fits:
- Person:Human — a biological human (the owner, colleagues, customers, anyone real).
- Persona:AI   — an AI agent / assistant / named AI persona (model-as-agent, AI companion).
- org          — a company, team, or organization.
- project / task / event / decision / note / question — dependent things owned by someone.
- thing        — ONLY when none of the above fits.
Type deterministically from context: a name in the owner field is Person:Human; a name in the
ai_personas list is Persona:AI. Never call the owner an org/thing; never call an AI persona a person/thing.

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
  supersedes the original. (Exception: SPEAKER MIND-FACTS below — a speaker's OWN belief/stance is
  validly a fact about the speaker.)
- predicate: a stable, stance-free label; reuse a known_predicate when it fits.
- object + object_kind: another node ("entity", give object_type) OR a value/stance ("literal").
- shape: "single" (one value at a time: a status/date/role — a later value replaces the earlier)
  vs "multi" (accumulates: a list — later values coexist with earlier). Use "multi" for
  commitments/tasks/todos/responsibilities/ownerships (a person has many); use "single" for a
  status/role/date/completion-state (one current value).
- source_span: the exact substring supporting the fact.

SPEAKER MIND-FACTS — capture what shapes a PERSONA, not a transcript of moves (emit IN ADDITION
to the world-facts above, never instead). The note is spoken by the speaker field. Emit a mind-fact
ONLY when the speaker reveals something DURABLE about how they think or want things done. Do NOT emit
one-off conversational mechanics — asking a question, acknowledging, dispatching a task, a status
update — those live in the verbatim, not the persona. When in doubt, emit nothing.

Tag each by lens: behavior | relationship | design | philosophy. Capture three kinds:

1. PREFERENCES & VALUES (soft — the DEFAULT). What the speaker likes, values, or judges as good.
   predicate = "<lens>: prefers" | "<lens>: values" | "<lens>: dislikes" | "<lens>: holds standard".
   Put the TOPIC in the object (e.g. "terse docs over verbose") so distinct topics never collide.
   shape = "single" (a later view on the SAME topic supersedes — this tracks how taste evolves).

2. DIRECTIVES (hard — ONLY when an explicit imperative marker is literally present: "always",
   "never", "must", "from now on", "don't ever", "rule:"). predicate = "directive: always" |
   "directive: never" | "directive: must". DEFAULT TO A PREFERENCE (#1) unless such a marker is
   actually in the text — NEVER invent a rule from a soft statement. shape = "single".

3. FEEDBACK on another participant (ONLY when explicitly marked — this is the signal that calibrates
   an agent). Each is a distinct lesson, so they ACCUMULATE:
   - correction (markers: "wrong", "no", "actually", "I meant", "correction") →
     {subject:<the corrector>, predicate:"received_correction", object:"<the fix> (was: <the error>)", shape:"multi"}
   - error/hallucination flagged → {subject:<who erred>, predicate:"erred", object:"<what was wrong>", shape:"multi"}
   - praise (markers: "well done", "exactly", "perfect", "good call", "nice catch") →
     {subject:<the praiser>, predicate:"praised", object:"<the good reasoning praised>", shape:"multi"}

Rules:
- subject = the speaker (for feedback, the corrector / praiser / the one who erred). Resolve
  "I"/"my"/"we" to the speaker. NEVER attribute one participant's stance or feedback to another.
- object = a literal that CARRIES THE TOPIC, so same-topic stances collide (supersede) and distinct
  topics coexist.
- Only emit when ACTUALLY expressed in this note — never invent.
- source_span = the exact words.
Example — note "Chatzi: From now on, always cite file:line. I like terse docs. Pythia, that was wrong — the owner is Person:Human, not org. Nice catch on the lazy client." →
  {subject:"Chatzi", subject_type:"Person:Human", predicate:"directive: always", object:"cite file:line in evidence", shape:"single", source_span:"From now on, always cite file:line"}
  {subject:"Chatzi", subject_type:"Person:Human", predicate:"design: prefers", object:"terse docs over verbose", shape:"single", source_span:"I like terse docs"}
  {subject:"Chatzi", subject_type:"Person:Human", predicate:"received_correction", object:"owner is Person:Human (was: org)", shape:"multi", source_span:"that was wrong — the owner is Person:Human, not org"}
  {subject:"Chatzi", subject_type:"Person:Human", predicate:"praised", object:"Pythia's lazy-client fix", shape:"multi", source_span:"Nice catch on the lazy client"}

COMMITMENTS (emit in ADDITION to facts, in a separate 'commitments' array) — a commitment is a
DIRECTED promise/agreement that someone WILL DO something, optionally by a time, optionally TO
someone. "Alice confirmed her team will hit the SSO deadline", "Bob said the migration ships Q2",
"I'll send you the report Friday" are commitments. Emit:
  {owner:<who will act>, owner_type:<kind>, recipient?:<who it is promised TO>, about?:<the thing/deal
   it concerns>, about_type?:<kind>, action:<what they will do>, due?:<when, free text ok>,
   modality:"promise"|"will"|"intend"|"must", source_span:<exact words>}
The owner is the party who must act (resolve a reported third party — "Bob said…" → owner Bob). REUSE
known_entities for owner/about so a later reversal can match this commitment.

REVERSALS (separate 'reversals' array) — when the note says an EARLIER commitment is now broken,
won't be met, slipped, was cancelled, or was fulfilled/done/delivered. Emit:
  {owner:<who>, about?:<the SAME thing the commitment was about, reusing its name even if reworded —
   "API rollout" = "API migration">, status:"broken"|"fulfilled"|"cancelled", source_span:<exact words>}
"can't make the SSO deadline" → {owner:Alice, about:"SSO deadline", status:"broken"}.
"won't finish the API rollout in time" → {owner:Bob, about:"API migration", status:"broken"}.

If no durable content, return {facts:[], commitments:[], reversals:[]}.`;

export async function extractFacts(
  content: string,
  speaker: string | null,
  interactionId: number,
  ctx?: ExtractContext,
): Promise<ExtractResult> {
  const context = ctx ?? { entities: [], predicates: [], account: null };
  const user = JSON.stringify({
    speaker: speaker ?? null,        // who is talking — the subject of any MIND-FACTS in this note
    account: context.account,
    owner: context.owner ?? null,
    ai_personas: context.ai_personas ?? [],
    known_entities: context.entities,
    known_predicates: context.predicates,
    note: `${speaker ? speaker + ": " : ""}${content}`,
  });
  const out = await llmJSON(SYSTEM, user);
  const facts: ExtractedFact[] = Array.isArray(out?.facts) ? out.facts : [];
  const commitments: ExtractedCommitment[] = Array.isArray(out?.commitments) ? out.commitments : [];
  const reversals: ExtractedReversal[] = Array.isArray(out?.reversals) ? out.reversals : [];
  logEvent("extract", { interaction_id: interactionId, content, account: context.account, facts, commitments, reversals });
  return { facts, commitments, reversals };
}
