import type { Node } from "./model";
import type { Schema } from "./schema";
import { applyStep, mapStep, StepError, type Step } from "./steps";
import { Transaction, type EditorState } from "./state";
import { contentSize } from "./tokens";

/**
 * Collaboration uses a central authority: the server holds the document and
 * a version counter, and accepts a batch of steps only when it was made
 * against the current version. A client whose batch is rejected receives the
 * steps it missed, rebases its unconfirmed steps over them, and resends.
 */

export interface Rebaseable {
  step: Step;
  inverted: Step;
}

export interface ConfirmedSteps {
  version: number;
  steps: Step[];
  clientIds: string[];
}

export interface AuthorityLimits {
  /** Steps kept so clients a little behind can catch up without a reload. */
  maxHistory: number;
  /** Total serialized size of the kept steps, in characters. */
  maxHistoryBytes: number;
  /** Largest document accepted, in positions (characters plus node boundaries). */
  maxDocSize: number;
}

/** Largest document, in positions: characters, leaf nodes, and two per other node. */
export const MAX_DOC_SIZE = 2_000_000;

const DEFAULT_LIMITS: AuthorityLimits = { maxHistory: 2000, maxHistoryBytes: 2 * 1024 * 1024, maxDocSize: MAX_DOC_SIZE };

export class Authority {
  doc: Node;
  version: number;
  /** Why the last `receive` returned null. */
  rejection: "stale" | "invalid" | "too-large" | null = null;
  private history: { step: Step; clientId: string; bytes: number }[] = [];
  private historyBytes = 0;
  readonly limits: AuthorityLimits;

  constructor(
    readonly schema: Schema,
    doc: Node,
    version = 0,
    limits: Partial<AuthorityLimits> = {},
  ) {
    this.doc = doc;
    this.version = version;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  /**
   * Applies a client's batch. Returns the accepted steps, or null when the
   * client is behind (it should fetch `stepsSince`), a step does not fit, or
   * the document would grow past its size limit; `rejection` says which.
   */
  receive(version: number, steps: Step[], clientId: string): Step[] | null {
    this.rejection = null;
    if (version !== this.version) {
      this.rejection = "stale";
      return null;
    }
    let doc = this.doc;
    try {
      for (const step of steps) doc = applyStep(doc, step, this.schema).doc;
    } catch (e) {
      if (e instanceof StepError || e instanceof RangeError) {
        this.rejection = "invalid";
        return null;
      }
      throw e;
    }
    const size = contentSize(doc, this.schema);
    // A document over the limit may still shrink.
    if (size > this.limits.maxDocSize && size > contentSize(this.doc, this.schema)) {
      this.rejection = "too-large";
      return null;
    }
    this.doc = doc;
    for (const step of steps) {
      const bytes = JSON.stringify(step).length;
      this.history.push({ step, clientId, bytes });
      this.historyBytes += bytes;
    }
    this.version += steps.length;
    let drop = 0;
    while (
      drop < this.history.length &&
      (this.history.length - drop > this.limits.maxHistory || this.historyBytes > this.limits.maxHistoryBytes)
    ) {
      this.historyBytes -= this.history[drop]!.bytes;
      drop++;
    }
    if (drop) this.history.splice(0, drop);
    return steps;
  }

  /** Steps after `version`, or null when they have aged out of history. */
  stepsSince(version: number): ConfirmedSteps | null {
    const start = this.version - this.history.length;
    if (version < start || version > this.version) return null;
    const slice = this.history.slice(version - start);
    return {
      version: this.version,
      steps: slice.map((s) => s.step),
      clientIds: slice.map((s) => s.clientId),
    };
  }
}

export class CollabClient {
  version: number;
  unconfirmed: Rebaseable[] = [];
  /** Batch sent and awaiting the server's answer. */
  inFlight = false;

  constructor(
    readonly clientId: string,
    version: number,
  ) {
    this.version = version;
  }

  /** Records local steps after a transaction was applied. */
  addLocal(tr: Transaction) {
    for (let i = 0; i < tr.steps.length; i++) {
      this.unconfirmed.push({ step: tr.steps[i]!, inverted: tr.inverses[i]! });
    }
  }

  sendable(): { version: number; steps: Step[] } | null {
    if (!this.unconfirmed.length) return null;
    return { version: this.version, steps: this.unconfirmed.map((u) => u.step) };
  }

  /**
   * Applies confirmed steps from the server. Steps that are this client's own
   * confirm the head of the unconfirmed queue; the rest are applied with the
   * remaining local steps rebased on top. Returns the transaction to apply
   * (null when nothing changed) and the mapping from the old document.
   */
  receive(state: EditorState, steps: Step[], clientIds: string[]): Transaction | null {
    this.version += steps.length;
    let ours = 0;
    while (ours < clientIds.length && clientIds[ours] === this.clientId) ours++;
    this.unconfirmed = this.unconfirmed.slice(ours);
    const remote = steps.slice(ours);
    if (!remote.length) return null;

    const tr = new Transaction(state);
    const local = this.unconfirmed;
    for (let i = local.length - 1; i >= 0; i--) tr.step(local[i]!.inverted);
    for (const step of remote) tr.step(step);
    const rebased: Rebaseable[] = [];
    let mapFrom = local.length;
    for (let i = 0; i < local.length; i++) {
      const mapped = mapStep(local[i]!.step, tr.mapping.slice(mapFrom));
      mapFrom--;
      if (mapped && tr.maybeStep(mapped, mapFrom)) {
        rebased.push({ step: mapped, inverted: tr.inverses[tr.inverses.length - 1]! });
      }
    }
    this.unconfirmed = rebased;
    tr.setMeta("remote", true);
    return tr;
  }
}
