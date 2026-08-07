---
name: asd-ste100
description: Write or rewrite technical documentation prose in ASD-STE100 (Simplified Technical English) style — short one-idea sentences, active voice, simple verb tenses, controlled vocabulary, no noun clusters, no jargon or idioms. Use whenever the user asks to write docs, rewrite a docs page, review prose for clarity, or mentions STE, Simplified Technical English, or ASD-STE100 by name. In this repo it also covers in-app copy: tooltip text (InfoTip), dialog and confirm-prompt copy, settings labels and help text, and CLI-mirroring error messages — not marketing copy, not code comments, not chat replies.
---

# ASD-STE100 for software documentation

ASD-STE100 is the aerospace industry's controlled-English standard for maintenance
manuals. It exists because ambiguous prose in a technical manual costs money or
lives. The full standard ties every word to a ~900-word approved dictionary built
for aircraft hardware, which does not fit software (it has no word for "API,"
"volume," or "Kubernetes"). This skill takes the standard's *structural*
discipline — the part that transfers to any technical domain — and applies it to
software docs, keeping domain vocabulary (API names, protocols, env vars, product
nouns) as a second, allowed layer on top of general-English words.

Apply this when writing or rewriting prose paragraphs in technical documentation.
Do not apply it to code, code comments, commit messages, or conversational replies
in chat — those follow their own conventions.

## Scope in this repo

mountos-desktop is a Tauri + Svelte menu-bar/tray app that shells out to the
`mountos` CLI and mirrors its documented flags one-to-one (see `PRODUCT.md`: "it
re-implements zero protocols; every action shells out to documented CLI
surface"). Apply STE to:

- Tooltip and `InfoTip` help text next to form fields.
- Dialog copy (confirm/cancel prompts, prune/remove dialogs).
- Settings and profile labels, and their descriptions.
- Error and status copy the UI renders from CLI output (job status, halt
  reasons, validation messages).

Do not apply it to marketing-register copy (if any onboarding/welcome screens
use a lighter voice), to code comments, or to the `CommandPreview` box, which
must show the literal CLI invocation verbatim, not a rewritten sentence.

## The rules, in order of impact

1. **One idea per sentence.** If a sentence has "and" joining two independent
   clauses, or a comma splice, split it. A reader parses two short sentences
   faster than one compound one, and a mistranslation or misreading only touches
   one idea at a time.

2. **Active voice, always.** The doer comes before the verb. "Load a signed
   license into the HUB" not "A signed license is loaded into the HUB." Passive
   voice hides who does the action, and in a procedure the reader needs to know
   if it's them, the system, or a specific service.

   Exception: when the actor is truly unknown or irrelevant even in context
   (rare in software docs — most operations have a clear actor: the client, the
   HUB, the operator).

3. **Simple, single-word-stem verb tenses only.**
   - Simple present for facts and standing behavior: "The HUB stores the license."
   - Simple past for completed events: "The client resolved the region."
   - Simple future for consequences: "The deployment will reject requests over
     the limit."
   - Imperative for instructions: "Load the license into the HUB."
   - Avoid: continuous forms (*is loading*), perfect forms (*has loaded*, *had
     loaded*), perfect-continuous forms (*has been loading*), and conditionals
     used as hedges (*would*, *could*, *might*). Use "can" for capability, "must"
     for a requirement, "must not" for a prohibition. Avoid "should" — it's
     ambiguous between recommendation and requirement; say which one you mean.

4. **Short sentences.** Roughly 20 words for an instruction, 25 for a
   description. Tooltip and dialog copy should aim shorter still, often under
   15 words — if a sentence runs longer, it usually has more than one idea in
   it — split it per rule 1 instead of just trimming words.

5. **One term per concept, used every time.** Don't vary vocabulary for
   elegance. If a tooltip calls it a "volume" once, it's a "volume" everywhere
   in this app, never "share" or "mount point" as a synonym. Match the exact
   CLI flag/subcommand names where the copy refers to them.

6. **No noun clusters over three nouns.** "region data plane operations" is a
   4-noun stack the reader has to unpack right to left. Rewrite with a
   preposition: "operations on the region's data plane."

7. **Keep articles.** "a," "an," "the" are never optional for brevity. Dropping
   them (a habit from headlines or terse comments) reads as ambiguous, not
   crisp, in a full sentence.

8. **No idioms, slang, or figurative verbs.** "spin up," "wire in," "under the
   hood," "end to end," "out of the box" — replace with the literal action:
   "start," "configure," "internally," "completely," "by default." A
   non-native reader has no guaranteed way to resolve figurative language.

9. **Convert 3+ sequential actions to a vertical list.** A sentence chaining
   three or more steps with commas and "then" is a procedure pretending to be
   a sentence. Use a numbered or bulleted list instead — one action per line,
   imperative mood.

10. **Avoid gerunds and -ing forms as adjectives.** "a client mounting it" →
    "a client that mounts it." "-ing" modifiers are compact but structurally
    ambiguous (is it a noun, a verb, an ongoing action?) — a full relative
    clause with "that" or "which" removes the ambiguity.

11. **Short paragraphs, one topic each.** A tooltip or dialog body should
    normally stay to one sentence; if it needs a second idea, that is often a
    sign the UI needs two separate hints instead of one long one.

## What this skill does NOT change

- Domain nouns stay: CLI subcommand and flag names, product names, protocol
  names, env var names, port numbers, file paths, code identifiers.
- Code, code comments, and the `CommandPreview` literal-command display are
  untouched — STE applies to explanatory prose, not to the command itself.
- It doesn't flatten voice into robotic monotone. Declarative and STE-compliant
  is still a register, not an absence of one.

## Workflow for rewriting UI copy or docs prose

1. Read the target copy (tooltip, dialog, settings label, or docs page).
2. For each sentence, check it against rules 1–4 first (idea count, voice,
   tense, length) — these catch the most readability loss.
3. Sweep related copy in the same view for rules 5–6 (vocabulary consistency,
   noun clusters) so terms match across every tooltip/dialog that touches the
   same concept.
4. Convert any 3+-step chained instruction into a list (rule 9).
5. Re-read end to end for flow. For short UI strings this mostly means: does
   it still read as one clear instruction or fact, not a fragment.
6. Do not change facts, add hedges, or remove operator-relevant detail (exact
   flag names, defaults, numeric limits) while simplifying grammar.
