import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  CONTINUE_TRIGGER,
  ContinueHandoffStore,
  continueHandoffContext,
  continueHandoffMissingWarning,
  isContinueRequest,
  lunaCheckpointText,
  parseLunaCheckpointSections,
} from "../src/adapters/chatgpt-web/continue-handoff";
import type { ContinueHandoff } from "../src/adapters/chatgpt-web/continue-handoff";
import { parseRequest } from "../src/responses/parser";

const tempDirs: string[] = [];

function tempPath(name = "handoff.json"): string {
  const dir = mkdtempSync(join(tmpdir(), "continue-handoff-"));
  tempDirs.push(dir);
  return join(dir, name);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      for (const file of ["handoff.json"]) {
        try { statSync(join(dir, file)); } catch { continue; }
      }
    } catch { /* best effort */ }
  }
});

const MODEL = "chatgpt-web/gpt-5.6-luna";

function userItem(turnId: string, text: string): Record<string, unknown> {
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  };
}

function assistantItem(turnId: string, text: string): Record<string, unknown> {
  return {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  };
}

function bodyFor(input: unknown[], turnId = "turn-1", threadId = "thread-1"): Record<string, unknown> {
  return {
    model: MODEL,
    stream: false,
    input,
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId }),
    },
  };
}

function requestFor(input: unknown[], turnId = "turn-1", threadId = "thread-1") {
  return parseRequest(bodyFor(input, turnId, threadId));
}

const SAMPLE_CHECKPOINT = [
  "Objective: Migrate the config loader to TOML",
  "State:",
  "- Wrote src/config/loader.ts",
  "- Added unit coverage for nested tables",
  "Evidence:",
  "- `bun test` passes 42/42",
  "Decisions:",
  "- Reject unknown keys instead of warning",
  "Pending:",
  "- Update the README migration note",
  "- Remove the legacy JSON fallback",
].join("\n");

describe("parseLunaCheckpointSections", () => {
  test("extracts the sections the Luna checkpoint contract already asks for", () => {
    const sections = parseLunaCheckpointSections(SAMPLE_CHECKPOINT);
    expect(sections.objective).toBe("Migrate the config loader to TOML");
    expect(sections.state).toEqual([
      "Wrote src/config/loader.ts",
      "Added unit coverage for nested tables",
    ]);
    expect(sections.evidence).toEqual(["`bun test` passes 42/42"]);
    expect(sections.decisions).toEqual(["Reject unknown keys instead of warning"]);
    expect(sections.pending).toEqual([
      "Update the README migration note",
      "Remove the legacy JSON fallback",
    ]);
  });

  test("treats the contract's empty placeholder as an empty section", () => {
    const sections = parseLunaCheckpointSections([
      "Objective: Nothing yet",
      "State:",
      "- None.",
      "Pending:",
      "- None.",
    ].join("\n"));
    expect(sections.objective).toBe("Nothing yet");
    expect(sections.state).toEqual([]);
    expect(sections.pending).toEqual([]);
  });

  test("continuation lines attach to the previous bullet", () => {
    const sections = parseLunaCheckpointSections([
      "State:",
      "- Wrote the loader",
      "  and its fixtures",
    ].join("\n"));
    expect(sections.state).toEqual(["Wrote the loader and its fixtures"]);
  });

  test("degrades to empty sections for unstructured prose", () => {
    const sections = parseLunaCheckpointSections("just some free text with no headings");
    expect(sections.state).toEqual([]);
    expect(sections.pending).toEqual([]);
    expect(sections.objective).toBeUndefined();
  });

  test("keeps blank-line-separated facts as distinct items", () => {
    const sections = parseLunaCheckpointSections([
      "Evidence:",
      "",
      "codex --version → codex-cli 0.157.1",
      "",
      "npm list -g → @openai/codex@0.157.1",
      "",
      "curl https://openai.com/codex/ failed with Could not resolve host.",
    ].join("\n"));
    expect(sections.evidence).toEqual([
      "codex --version → codex-cli 0.157.1",
      "npm list -g → @openai/codex@0.157.1",
      "curl https://openai.com/codex/ failed with Could not resolve host.",
    ]);
  });

  test("caps item length so a runaway checkpoint cannot grow without bound", () => {
    const sections = parseLunaCheckpointSections(`Pending:\n- ${"x".repeat(5_000)}`);
    expect(sections.pending[0]!.length).toBeLessThanOrEqual(2_000);
  });
});

describe("lunaCheckpointText", () => {
  test("returns the verbatim body for the live v2 checkpoint", () => {
    expect(lunaCheckpointText({ version: 2, summary: SAMPLE_CHECKPOINT })).toBe(SAMPLE_CHECKPOINT);
  });

  test("re-renders a legacy v1 record into the same heading form", () => {
    const text = lunaCheckpointText({
      version: 1,
      objective: "Do the thing",
      state: ["step one"],
      evidence: [],
      decisions: [],
      pending: ["step two"],
    });
    expect(parseLunaCheckpointSections(text).pending).toEqual(["step two"]);
    expect(parseLunaCheckpointSections(text).objective).toBe("Do the thing");
  });
});

describe("isContinueRequest", () => {
  test("matches an exact continue as the opening message of a new thread", () => {
    expect(isContinueRequest(requestFor([userItem("turn-1", CONTINUE_TRIGGER)]))).toBeTrue();
  });

  test("is case-insensitive but still exact", () => {
    expect(isContinueRequest(requestFor([userItem("turn-1", "Continue")]))).toBeTrue();
    expect(isContinueRequest(requestFor([userItem("turn-1", "CONTINUE")]))).toBeTrue();
  });

  test("rejects a longer prompt that merely contains continue", () => {
    expect(isContinueRequest(requestFor([userItem("turn-1", "please continue")]))).toBeFalse();
    expect(isContinueRequest(requestFor([userItem("turn-1", "continue from where we left off")]))).toBeFalse();
    expect(isContinueRequest(requestFor([userItem("turn-1", "continue.")]))).toBeFalse();
  });

  test("never fires mid-thread, where a completed parent answer exists", () => {
    const parsed = requestFor(
      [
        userItem("turn-1", "start the migration"),
        assistantItem("turn-1", "done"),
        userItem("turn-2", "continue"),
      ],
      "turn-2",
    );
    expect(isContinueRequest(parsed)).toBeFalse();
  });

  test("rejects an unrelated first message", () => {
    expect(isContinueRequest(requestFor([userItem("turn-1", "refactor the loader")]))).toBeFalse();
  });

  test("requires native thread and turn identity", () => {
    const parsed = parseRequest({ model: MODEL, stream: false, input: [userItem("turn-1", "continue")] });
    expect(isContinueRequest(parsed)).toBeFalse();
  });
});

describe("ContinueHandoffStore", () => {
  test("records a completed turn and reads it back", () => {
    const store = new ContinueHandoffStore(tempPath());
    const recorded = store.recordTurn(
      requestFor([userItem("turn-1", "start")]),
      { checkpointText: SAMPLE_CHECKPOINT },
    );
    expect(recorded).toBeTrue();
    const latest = store.latest();
    expect(latest?.threadId).toBe("thread-1");
    expect(latest?.sourceTurnId).toBe("turn-1");
    expect(latest?.pending).toEqual([
      "Update the README migration note",
      "Remove the legacy JSON fallback",
    ]);
  });

  // Windows has no POSIX mode bits; atomicWriteFile leaves its ACLs to the installer, so only
  // the mode assertion is platform-specific. Writing itself is covered on every platform.
  test("writes the handoff file", () => {
    const path = tempPath();
    const store = new ContinueHandoffStore(path);
    store.recordTurn(requestFor([userItem("turn-1", "start")]), { checkpointText: SAMPLE_CHECKPOINT });
    expect(store.latest()?.objective).toBe("Migrate the config loader to TOML");
  });

  test.skipIf(process.platform === "win32")("writes the handoff with owner-only permissions", () => {
    const path = tempPath();
    const store = new ContinueHandoffStore(path);
    store.recordTurn(requestFor([userItem("turn-1", "start")]), { checkpointText: SAMPLE_CHECKPOINT });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("a checkpoint with no usable sections falls back to the turn itself", () => {
    const store = new ContinueHandoffStore(tempPath());
    expect(store.recordTurn(requestFor([userItem("turn-1", "hi")]), { checkpointText: "no headings here" })).toBeTrue();
    expect(store.latest()?.source).toBe("answer");
  });

  test("records a fallback handoff when Luna emitted no private checkpoint", () => {
    const store = new ContinueHandoffStore(tempPath());
    const recorded = store.recordTurn(
      requestFor([userItem("turn-1", "check my disk usage")]),
      { answer: "Your main Linux disk is 63 GB.\n\n34 GB used and 27 GB free." },
    );
    expect(recorded).toBeTrue();
    const latest = store.latest();
    expect(latest?.source).toBe("answer");
    expect(latest?.objective).toBe("check my disk usage");
    expect(latest?.state.length).toBeGreaterThan(0);
    // Remaining work is deliberately left empty rather than invented.
    expect(latest?.pending).toEqual([]);
  });

  test("prefers the checkpoint over the answer fallback when both are present", () => {
    const store = new ContinueHandoffStore(tempPath());
    store.recordTurn(requestFor([userItem("turn-1", "start")]), {
      checkpointText: SAMPLE_CHECKPOINT,
      answer: "some visible answer",
    });
    expect(store.latest()?.source).toBe("checkpoint");
    expect(store.latest()?.pending).toEqual([
      "Update the README migration note",
      "Remove the legacy JSON fallback",
    ]);
  });

  test("records nothing when there is neither a checkpoint nor an answer", () => {
    const store = new ContinueHandoffStore(tempPath());
    const parsed = parseRequest({
      model: MODEL,
      stream: false,
      input: [{ type: "message", role: "user", content: "x" }],
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread-1", turn_id: "turn-1" }) },
    });
    expect(store.recordTurn(parsed, {})).toBeFalse();
    expect(store.latest()).toBeUndefined();
  });

  test("a corrupt handoff file never breaks a turn", () => {
    const path = tempPath();
    writeFileSync(path, "{ this is not json", { mode: 0o600 });
    const store = new ContinueHandoffStore(path);
    expect(store.latest()).toBeUndefined();
    const result = store.apply(requestFor([userItem("turn-1", "continue")]));
    expect(result.applied).toBeFalse();
    expect(result.reason).toBe("no stored previous session");
  });

  test("a handoff belonging to another schema version is ignored", () => {
    const path = tempPath();
    writeFileSync(path, JSON.stringify({ version: 99, handoff: {} }), { mode: 0o600 });
    expect(new ContinueHandoffStore(path).latest()).toBeUndefined();
  });

  test("does nothing for an ordinary first message", () => {
    const store = new ContinueHandoffStore(tempPath());
    store.recordTurn(requestFor([userItem("turn-1", "start")]), { checkpointText: SAMPLE_CHECKPOINT });
    const result = store.apply(requestFor([userItem("turn-1", "refactor the loader")]));
    expect(result.applied).toBeFalse();
    expect(result.reason).toBe("not an explicit continue request");
  });

  test("resumes an explicit continue by replaying the handoff as assistant state", () => {
    const store = new ContinueHandoffStore(tempPath());
    store.recordTurn(
      requestFor([userItem("turn-9", "start the migration")], "turn-9"),
      { checkpointText: SAMPLE_CHECKPOINT },
    );

    const result = store.apply(requestFor([userItem("turn-1", "continue")]));
    expect(result.applied).toBeTrue();
    expect(result.reason).toBeUndefined();

    const messages = result.parsed.context.messages;
    expect(messages[0]?.role).toBe("assistant");
    const injected = JSON.stringify(messages[0]);
    expect(injected).toContain("Migrate the config loader to TOML");
    expect(injected).toContain("Remove the legacy JSON fallback");
    // The user's own instruction must remain the authoritative final turn input.
    expect(messages[messages.length - 1]?.role).toBe("user");
  });

  test("resume preserves the active native user revision", () => {
    const store = new ContinueHandoffStore(tempPath());
    store.recordTurn(requestFor([userItem("turn-9", "start")], "turn-9"), { checkpointText: SAMPLE_CHECKPOINT });
    const parsed = requestFor([userItem("turn-1", "continue")]);
    const beforeUsers = parsed.context.messages
      .filter(message => message.role === "user")
      .map(message => message.content);
    const result = store.apply(parsed);
    expect(result.applied).toBeTrue();
    const afterUsers = result.parsed.context.messages
      .filter(message => message.role === "user")
      .map(message => message.content);
    // The user's own instruction is unchanged; only assistant state was prepended.
    expect(afterUsers).toEqual(beforeUsers);
  });

  test("resume is idempotent in effect: the same handoff replays identically", () => {
    const store = new ContinueHandoffStore(tempPath());
    store.recordTurn(requestFor([userItem("turn-9", "start")], "turn-9"), { checkpointText: SAMPLE_CHECKPOINT });
    const stripTimestamps = (messages: Array<{ role: string; content: unknown }>) =>
      JSON.stringify(messages.map(({ role, content }) => ({ role, content })));
    const first = store.apply(requestFor([userItem("turn-1", "continue")]));
    const second = store.apply(requestFor([userItem("turn-1", "continue")]));
    expect(stripTimestamps(first.parsed.context.messages))
      .toBe(stripTimestamps(second.parsed.context.messages));
  });

  test("does not resume when nothing has been recorded yet", () => {
    const store = new ContinueHandoffStore(tempPath());
    const result = store.apply(requestFor([userItem("turn-1", "continue")]));
    expect(result.applied).toBeFalse();
    expect(result.reason).toBe("no stored previous session");
    expect(continueHandoffMissingWarning()).toContain("No previous session handoff");
  });

  test("a new record supersedes the previous one", () => {
    const store = new ContinueHandoffStore(tempPath());
    store.recordTurn(requestFor([userItem("t1", "a")], "t1"), { checkpointText: "Objective: first\nPending:\n- one" });
    store.recordTurn(requestFor([userItem("t2", "b")], "t2"), { checkpointText: "Objective: second\nPending:\n- two" });
    expect(store.latest()?.objective).toBe("second");
    expect(store.latest()?.sourceTurnId).toBe("t2");
  });
});

describe("continueHandoffContext", () => {
  test("frames the replayed state as prior assistant state, not a new instruction", () => {
    const handoff: ContinueHandoff = {
      version: 1,
      threadId: "thread-1",
      sourceTurnId: "turn-1",
      updatedAt: Date.now(),
      objective: "Do the thing",
      state: ["step one"],
      evidence: [],
      decisions: [],
      pending: ["step two"],
    };
    const text = continueHandoffContext(handoff);
    expect(text).toContain("not as a new user instruction");
    expect(text).toContain("Remaining:");
    expect(text).toContain("- step two");
    expect(text).not.toContain("Evidence:");
  });

  test("discloses when the handoff is derived rather than from a checkpoint", () => {
    const handoff: ContinueHandoff = {
      version: 1,
      source: "answer",
      threadId: "thread-1",
      sourceTurnId: "turn-1",
      updatedAt: Date.now(),
      objective: "check my disk usage",
      state: ["34 GB used"],
      evidence: [],
      decisions: [],
      pending: [],
    };
    expect(continueHandoffContext(handoff)).toContain("no private checkpoint was emitted");
  });

  test("stored handoff content survives a file round trip", () => {
    const path = tempPath();
    const store = new ContinueHandoffStore(path);
    store.recordTurn(requestFor([userItem("turn-1", "start")]), { checkpointText: SAMPLE_CHECKPOINT });
    const file = JSON.parse(readFileSync(path, "utf8"));
    expect(file.version).toBe(1);
    expect(file.handoff.version).toBe(1);
  });
});
