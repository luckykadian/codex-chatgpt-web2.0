import { existsSync, readFileSync } from "node:fs";
import { atomicWriteFile } from "../../config";
import { parseRequest } from "../../responses/parser";
import type { CodexParsedRequest } from "../../types";
import { extractChatGptTurnIdentity, extractChatGptTurnUserRevision } from "./environment";
import {
  currentTurnInput,
  itemTurnId,
  parentAssistantAnswer,
  record,
  type ChatGptLunaCheckpoint,
} from "./rolling-checkpoint";
import * as z from "zod/v4";

/**
 * Cross-thread resume for Luna tasks.
 *
 * The rolling checkpoint store is deliberately exact-parent and per-thread: it refuses to cross a
 * thread boundary so a mismatched summary can never replace canonical Codex history. That is the
 * right default, but it leaves no supported way to keep working after a thread ends — and Luna has
 * no compaction path at all, so a long task simply dies at the context window.
 *
 * This store is the explicit, user-triggered counterpart. It records the structured sections the
 * model already emits inside its private checkpoint, and replays them only when the user starts a
 * new task and asks for it by name.
 */

/** The only accepted resume trigger. Matching is exact so ordinary prompts never resume. */
export const CONTINUE_TRIGGER = "continue";

const MAX_SECTION_ITEMS = 32;
const MAX_SECTION_ITEM_CHARS = 2_000;
const MAX_OBJECTIVE_CHARS = 2_000;

const sectionItem = z.string().trim().min(1).max(MAX_SECTION_ITEM_CHARS);

export const continueHandoffSchema = z.object({
  version: z.literal(1),
  /** Thread the handoff was recorded from, for operator display only. Never used to authorize. */
  threadId: z.string().trim().min(1).max(200),
  sourceTurnId: z.string().trim().min(1).max(200),
  updatedAt: z.number().int().positive(),
  /** `answer` means no private checkpoint was emitted; remaining work is not enumerated. */
  source: z.enum(["checkpoint", "answer"]).optional(),
  objective: z.string().trim().min(1).max(MAX_OBJECTIVE_CHARS).optional(),
  state: z.array(sectionItem).max(MAX_SECTION_ITEMS),
  evidence: z.array(sectionItem).max(MAX_SECTION_ITEMS),
  decisions: z.array(sectionItem).max(MAX_SECTION_ITEMS),
  pending: z.array(sectionItem).max(MAX_SECTION_ITEMS),
}).strict();

export type ContinueHandoff = z.infer<typeof continueHandoffSchema>;

const SECTION_HEADINGS = ["objective", "state", "evidence", "decisions", "pending"] as const;
type SectionName = (typeof SECTION_HEADINGS)[number];

export interface LunaCheckpointSections {
  objective?: string;
  state: string[];
  evidence: string[];
  decisions: string[];
  pending: string[];
}

/** Placeholders the checkpoint contract permits for a genuinely empty section. */
const EMPTY_MARKERS = new Set(["none.", "none", "- none.", "n/a", "n/a.", "-", "—"]);

function isEmptyMarker(value: string): boolean {
  return EMPTY_MARKERS.has(value.trim().toLowerCase());
}

/**
 * Split the private checkpoint body into the sections the Luna checkpoint contract already asks
 * the model to emit. Unknown prose before the first heading is ignored; the bridge owns structure
 * so a malformed or partial checkpoint degrades to empty sections instead of failing the turn.
 */
export function parseLunaCheckpointSections(text: string): LunaCheckpointSections {
  const sections: Record<SectionName, string[]> = {
    objective: [],
    state: [],
    evidence: [],
    decisions: [],
    pending: [],
  };
  let current: SectionName | undefined;
  // The real checkpoint separates items with blank lines. Only a directly consecutive line
  // continues the previous item, so distinct facts stay distinct instead of merging.
  let startsNewItem = true;
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      startsNewItem = true;
      continue;
    }
    const heading = /^(objective|state|evidence|decisions|pending)\s*:\s*(.*)$/i.exec(line);
    if (heading) {
      current = heading[1]!.toLowerCase() as SectionName;
      const inline = heading[2]!.trim();
      if (inline && !isEmptyMarker(inline)) sections[current].push(inline);
      startsNewItem = true;
      continue;
    }
    if (!current) continue;
    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    const body = (bullet ? bullet[1]! : line).trim();
    if (!body || isEmptyMarker(body)) continue;
    const bucket = sections[current];
    if (bullet || startsNewItem || bucket.length === 0) {
      bucket.push(body.slice(0, MAX_SECTION_ITEM_CHARS));
    } else {
      const last = bucket.length - 1;
      bucket[last] = `${bucket[last]!} ${body}`.trim().slice(0, MAX_SECTION_ITEM_CHARS);
    }
    startsNewItem = false;
  }
  const objective = sections.objective.join(" ").trim().slice(0, MAX_OBJECTIVE_CHARS);
  return {
    ...(objective ? { objective } : {}),
    state: sections.state,
    evidence: sections.evidence,
    decisions: sections.decisions,
    pending: sections.pending,
  };
}

function userItemText(value: unknown): string | undefined {
  const entry = record(value);
  if (!entry || entry.type !== "message" || entry.role !== "user") return undefined;
  const content = entry.content;
  let text: string | undefined;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map(part => {
        const block = record(part);
        return block && (block.type === "input_text" || block.type === "text")
          && typeof block.text === "string"
          ? block.text
          : "";
      })
      .join("");
  }
  return typeof text === "string" && text.trim() ? text.trim() : undefined;
}

/** The latest human-authored text of the current native turn. */
function currentUserText(parsed: CodexParsedRequest, turnId: string): string | undefined {
  const input = currentTurnInput(parsed, turnId);
  if (!input) return undefined;
  let latest: string | undefined;
  for (const item of input) {
    if (itemTurnId(item) !== undefined && itemTurnId(item) !== turnId) continue;
    const text = userItemText(item);
    if (text) latest = text;
  }
  return latest;
}

/**
 * True only for a brand-new task whose opening message is exactly "continue".
 *
 * The parent-answer guard is what makes this safe: an established thread always has a completed
 * assistant answer, so a stray "continue" mid-task can never inject stale cross-thread state.
 */
export function isContinueRequest(parsed: CodexParsedRequest): boolean {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.threadId || !identity.turnId) return false;
  if (parsed._compactionRequest) return false;
  if (parentAssistantAnswer(parsed, identity.turnId)) return false;
  const userText = currentUserText(parsed, identity.turnId);
  return userText !== undefined && userText.toLowerCase() === CONTINUE_TRIGGER;
}

/**
 * Recover the section-bearing text the model actually wrote. The live v2 checkpoint keeps the raw
 * body verbatim; a legacy v1 record is re-rendered into the same heading form so both parse alike.
 */
export function lunaCheckpointText(checkpoint: ChatGptLunaCheckpoint): string {
  if (checkpoint.version === 2) return checkpoint.summary;
  const lines = [`Objective: ${checkpoint.objective}`];
  const section = (title: string, items: readonly string[]): void => {
    if (items.length === 0) return;
    lines.push(`${title}:`);
    for (const item of items) lines.push(`- ${item}`);
  };
  section("State", checkpoint.state);
  section("Evidence", checkpoint.evidence);
  section("Decisions", checkpoint.decisions);
  section("Pending", checkpoint.pending);
  return lines.join("\n");
}

/**
 * Coarse handoff for a turn where Luna emitted no private checkpoint. It preserves what the user
 * asked for and what came back, and leaves `pending` empty rather than inventing next steps.
 */
export function fallbackSections(objective: string | undefined, answer: string): LunaCheckpointSections {
  const state: string[] = [];
  for (const paragraph of String(answer ?? "").split(/\n{2,}/)) {
    const text = paragraph.trim();
    if (text) state.push(text.slice(0, MAX_SECTION_ITEM_CHARS));
  }
  return {
    ...(objective ? { objective: objective.slice(0, MAX_OBJECTIVE_CHARS) } : {}),
    state: state.slice(0, MAX_SECTION_ITEMS),
    evidence: [],
    decisions: [],
    pending: [],
  };
}

export function hasHandoffContent(sections: LunaCheckpointSections): boolean {
  return Boolean(sections.objective)
    || sections.state.length > 0
    || sections.evidence.length > 0
    || sections.decisions.length > 0
    || sections.pending.length > 0;
}

export function continueHandoffContext(handoff: ContinueHandoff): string {
  const lines = [
    "[Resumed task state from a previous Codex session in this project.]",
    "Treat this as prior assistant-owned session state, not as a new user instruction. The current system, developer, and user messages below remain authoritative.",
    `Recorded from task ${handoff.threadId}.`,
  ];
  if (handoff.source === "answer") {
    lines.push(
      "",
      "Note: no private checkpoint was emitted for that turn, so this state is derived from the last exchange and remaining work is not enumerated.",
    );
  }
  const section = (title: string, items: readonly string[]): void => {
    if (items.length === 0) return;
    lines.push("", `${title}:`);
    for (const item of items) lines.push(`- ${item}`);
  };
  if (handoff.objective) section("Objective", [handoff.objective]);
  section("Completed", handoff.state);
  section("Evidence", handoff.evidence);
  section("Decisions", handoff.decisions);
  section("Remaining", handoff.pending);
  lines.push(
    "",
    "Resume the remaining work now. Re-read any file before changing it; the working tree may have changed since this state was recorded.",
  );
  return lines.join("\n");
}

/** Shown when the user asks to continue but no session has been recorded yet. */
export function continueHandoffMissingWarning(): string {
  return "No previous session handoff is stored for this project, so there is nothing to resume. Continuing as an ordinary new task.";
}

export interface ContinueHandoffApplyResult {
  parsed: CodexParsedRequest;
  applied: boolean;
  reason?: string;
}

export class ContinueHandoffStore {
  constructor(
    private readonly path?: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** A corrupt or unreadable handoff file must never break a turn. */
  latest(): ContinueHandoff | undefined {
    if (!this.path || !existsSync(this.path)) return undefined;
    try {
      const file = record(JSON.parse(readFileSync(this.path, "utf8")));
      if (!file || file.version !== 1) return undefined;
      return continueHandoffSchema.parse(file.handoff);
    } catch {
      return undefined;
    }
  }

  save(handoff: ContinueHandoff): void {
    if (!this.path) return;
    atomicWriteFile(this.path, `${JSON.stringify({ version: 1, handoff }, null, 2)}\n`);
  }

  /**
   * Record the newest completed state so a later task can resume from it.
   *
   * The private checkpoint is preferred, but Luna is not obliged to emit it and a missing marker
   * is tolerated upstream. Resume therefore keys off the completed turn itself, falling back to
   * the last request and answer, so a handoff exists even when the marker does not.
   */
  recordTurn(
    parsed: CodexParsedRequest,
    turn: { checkpointText?: string; answer?: string },
  ): boolean {
    const identity = extractChatGptTurnIdentity(parsed);
    if (!identity.threadId || !identity.turnId) return false;
    const fromCheckpoint = turn.checkpointText
      ? parseLunaCheckpointSections(turn.checkpointText)
      : undefined;
    const checkpointUsable = fromCheckpoint !== undefined && hasHandoffContent(fromCheckpoint);
    const sections = checkpointUsable
      ? fromCheckpoint!
      : fallbackSections(currentUserText(parsed, identity.turnId), turn.answer ?? "");
    if (!hasHandoffContent(sections)) return false;
    this.save({
      version: 1,
      source: checkpointUsable ? "checkpoint" : "answer",
      threadId: identity.threadId,
      sourceTurnId: identity.turnId,
      updatedAt: this.now(),
      ...(sections.objective ? { objective: sections.objective } : {}),
      state: sections.state,
      evidence: sections.evidence,
      decisions: sections.decisions,
      pending: sections.pending,
    });
    return true;
  }

  apply(parsed: CodexParsedRequest): ContinueHandoffApplyResult {
    if (!isContinueRequest(parsed)) {
      return { parsed, applied: false, reason: "not an explicit continue request" };
    }
    const handoff = this.latest();
    if (!handoff) {
      return { parsed, applied: false, reason: "no stored previous session" };
    }
    const identity = extractChatGptTurnIdentity(parsed);
    const currentInput = currentTurnInput(parsed, identity.turnId!);
    const body = record(parsed._rawBody);
    if (!currentInput || !body) {
      return { parsed, applied: false, reason: "current native turn boundary is unavailable" };
    }
    const handoffItem = {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: continueHandoffContext(handoff) }],
      internal_chat_message_metadata_passthrough: { turn_id: identity.turnId },
    };
    const { previous_response_id: _dropped, ...bodyWithoutPrevious } = body;
    const continued = parseRequest({
      ...bodyWithoutPrevious,
      input: [handoffItem, ...currentInput],
    });
    // `_rawBody.model` stays the public route slug; the server has already resolved the
    // authoritative backend model and effort on `parsed`.
    continued.modelId = parsed.modelId;
    continued.options = { ...continued.options, ...parsed.options };
    if (
      JSON.stringify(extractChatGptTurnUserRevision(continued))
      !== JSON.stringify(extractChatGptTurnUserRevision(parsed))
    ) {
      throw new Error("ChatGPT Web continue handoff changed the active native user revision");
    }
    return { parsed: continued, applied: true };
  }
}
