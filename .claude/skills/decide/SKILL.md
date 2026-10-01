---
name: decide
description: Record a decision and update every document it changes. Use whenever a person decides something that differs from, or adds to, what the documents in docs/ or CLAUDE.md say.
argument-hint: "[the decision, in a sentence]"
---

The decision: $ARGUMENTS

A decision is not finished until the documents say it. Both people's sessions read these files, so a decision that lives only in a chat is lost.

1. **Who decided.** If it is not clear that a person decided this, ask. An agent's suggestion is not a decision.
2. **Find what it changes.** Search `docs/`, `CLAUDE.md`, `.claude/` and `README.md` for every place that states the old position: the numbers, the names and the sentences. List them.
3. **Record it** in `docs/GATES.md`, under a heading `Decided on <date> (<who decided>)`: the gate name, status `DECIDED`, the decision, and the facts behind it in one line. If it reverses an earlier row, mark that row `SUPERSEDED` with the date and point it at the new one.
4. **Update each place you found** so it states the new position. Do not leave the old sentence beside the new one.
5. **Check for contradictions:** search again for the old value. Nothing should still state it, apart from dated history.
6. **Commit** the record and the updates together, with a `docs:` prefix, in the branch of the work the decision belongs to, or in a small branch of its own into `staging`.

Then tell the person which files changed.
