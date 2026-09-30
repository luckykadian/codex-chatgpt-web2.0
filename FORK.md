# Fork: Luna session resume for Free & Go

This fork adds one capability to [Codex Web GPT](https://github.com/miuuyy/codex-chatgpt-web):
**`continue` in a new thread resumes the task you were forced to abandon.**

Upstream is unchanged in every other respect, including model routing, browser automation,
security model, and packaging.

---

## The problem: Free and Go have no recovery path

A Free or Go subscription has no Sol model selector, so the bridge routes every request through
Luna (`chatgpt-web/gpt-5.6-luna`). Luna is the only route where **every** recovery mechanism is
switched off by design:

| Recovery path | Available on Luna? | Why |
|---|---|---|
| Auto-compaction | ✗ | `auto_compact_token_limit` is set equal to `context_window` (1,050,000), so it never fires |
| Manual `/compact` | ✗ | Rejected with **HTTP 409** — deliberate, and asserted by two tests |
| Bigger Context | ✗ | Rejected with **HTTP 400** (see below) |
| Sol / Pro model rows | ✗ | `!solAvailable` yields Luna routes only |

The result: a long task grows until Codex reports *"ran out of room in the model's context
window"*, and the only supported answer is to start a new thread — **discarding everything the
task had accumulated**.

Luna is nominally advertised with a 1,050,000-token window, which makes the failure confusing.
That number is the underlying model's window, not a usable budget: the browser payload is bounded
separately by a rolling checkpoint (≤ 4,000 tokens) inside a 28,000-token transport budget. Codex
meters its own canonical history against the 1,050,000 figure and eventually walks off the edge.

---

## Why Bigger Context does not help Free/Go

This is worth stating plainly, because it looks like the obvious fix and it is not one.

Bigger Context works by splitting one large context across **2 or 6** ChatGPT messages instead of
one. That only creates headroom when each message gets its own independent budget.

Luna does not work that way. Every later browser request carries the accumulated transcript
**inside the same 28,000-token transport budget**. Splitting the context into more messages does
not add headroom — the transcript is still there, still counted against one ceiling.

So the bridge rejects it explicitly, in four places, with the same reasoning:

> "Bigger Context is unavailable for Luna because its accumulated browser transcript still shares
> one 28,000-token transport budget."

and, at the transport layer:

> "Bigger Context staging is unavailable for a Luna-only account." — HTTP 400

**This fork does not change that, and does not try to.** It is a transport constraint of how Luna
carries conversation state, not a missing feature. Bigger Context remains fully functional on Sol
and Pro rows, which Free/Go cannot select.

---

## What this fork adds

Instead of making the context bigger, it makes hitting the limit **survivable**.

Every completed Luna turn records a structured handoff to
`~/.codex-chatgpt-web/runtime/continue-handoff.json` (mode `0600`), capturing:

- **Objective** — what the task is
- **State** — what has been done
- **Evidence** — command results, paths, observations
- **Decisions** — choices made, and why
- **Pending** — what is left to do

Then, when you start a **new** thread and type exactly `continue`, that state is replayed as prior
assistant-owned context, and the model resumes the pending work.

### It records whether or not Luna cooperates

The handoff is preferentially built from the private rolling checkpoint Luna appends to its
answers. But Luna is **not obliged to emit that checkpoint** — upstream tolerates its absence via
`finishOptional()`. Observed in practice: a real turn completed with no checkpoint at all, and the
original implementation silently recorded nothing.

So the handoff keys off the **completed turn** instead, which always happens:

- checkpoint present → use its structured sections (`source: "checkpoint"`)
- checkpoint absent → fall back to the last user request plus the assistant's answer
  (`source: "answer"`), leaving `pending` empty rather than inventing next steps

The `source` field is carried into the replayed context so a coarse handoff is never mistaken for a
rich one.

### The trigger is deterministic

Resume fires only when **all** of these hold:

1. The message is **exactly** `continue` (case-insensitive) — not "please continue" or "continue."
2. It is the **opening message of a new thread** — the parent-answer guard means an established
   thread can never trigger it, so a stray "continue" mid-task cannot inject stale state
3. A stored handoff exists — otherwise a visible notice is shown and the turn continues normally
4. The active native user revision is verified unchanged before the turn proceeds

All four are enforced in code, not by asking the model to behave.

---

## Why not just instruct Codex to maintain a `CONTINUE.md`?

A reasonable-looking workaround is a custom instruction telling the model to write and read a
handoff file. It fails in ways that are inherent to instruction-following:

| | `CONTINUE.md` instruction | This fork |
|---|---|---|
| Reliable every turn | ✗ depends on the model complying | ✓ code path, unconditional |
| Only fires on request | ✗ model reads it opportunistically | ✓ exact string match |
| Updates after every prompt | ✗ gets dropped on long turns | ✓ written by the bridge |
| Stale-file risk | ✗ old files persist in the tree | ✓ one file, overwritten |
| Context cost | ✗ a tool call + tokens **every turn** | ✓ zero — reuses the checkpoint |
| Per-project | ✓ lives in the project directory | ✗ currently global |

The context cost matters most: writing and reading a file every turn consumes the very budget you
are trying to preserve.

The one thing the instruction approach does better is **per-project scoping** — see limitations.

---

## What changed

| File | Change |
|---|---|
| `src/adapters/chatgpt-web/continue-handoff.ts` | New. Section parser, trigger detection, store, replay context |
| `src/adapters/chatgpt-web/index.ts` | Record on completed turn; replay on trigger; emit notice |
| `src/adapters/chatgpt-web/rolling-checkpoint.ts` | Export shared helpers |
| `src/config.ts`, `src/types.ts` | `continueHandoffStatePath` plumbing |
| `src/dev-chat/driver.ts` | DEV profile gets its own handoff file |
| `tests/continue-handoff.test.ts` | 31 tests |
| `docs/architecture.md` | Design notes |

Test suite: **833 pass**, 22 skip. The 3 failures are pre-existing Zero Risk compaction tests,
untouched by these changes.

---

## Build and install (Linux x64)

```fish
cd ~/Documents/Codex2.0/codex-chatgpt-web2.0
bun install --frozen-lockfile
bun install --cwd launcher --frozen-lockfile
bun run app:package
```

Quit the launcher, confirm it is gone, then install:

```fish
pkill -9 -f "Codex Web GPT"
pgrep -af "Codex Web GPT"        # must print nothing
cp launcher/artifacts/codex-web-gpt-6.1.3-linux-x64.AppImage \
   ~/.local/lib/codex-web-gpt/6.1.3/"Codex Web GPT.AppImage"
```

Launch, then confirm the new runtime is live:

```fish
grep -c "no private checkpoint was emitted" \
  ~/.codex-chatgpt-web/versions/6.1.3-linux-x64/app/cli.js     # expect 1
```

**Note:** the `cp` fails with `Text file busy` if the old AppImage is still executing. Always
confirm the process is dead before copying.

Your ChatGPT login and launcher settings are unaffected — they live in `~/.codex-chatgpt-web/` and
`~/.config/Codex Web GPT`, outside both the AppImage and the runtime directory.

---

## Usage

1. Work normally on `chatgpt-web/gpt-5.6-luna`
2. When Codex hits the context limit, start a **new thread**
3. Type exactly `continue`
4. The task resumes from its recorded objective, state, and pending work

Inspect or clear what is stored at any time:

```fish
cat ~/.codex-chatgpt-web/runtime/continue-handoff.json
```

---

## Limitations

- **Not scoped per project.** One global file, so the most recently completed Luna turn wins
  regardless of directory. Switching projects and typing `continue` resumes the *other* project.
  Fixing this is the main outstanding task; the bridge already tracks a validated `cwd` per thread.
- **A summary, not a snapshot.** The handoff carries what the model recorded — not file contents or
  working-tree state. The replayed context instructs the model to re-read files before changing
  them, and in Full harness it can, since your tools are available.
- **Does not raise any context limit.** Nothing here lets Luna hold more context. It only removes
  the penalty for running out.
