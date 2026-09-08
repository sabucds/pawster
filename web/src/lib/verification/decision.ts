/**
 * Reading a decision form, and refusing one that would make a verification entry worth
 * less than no entry at all.
 *
 * Pure, like `../auth/registration.ts` and `../shelter/profile.ts`, and for the same reason
 * those two are: the rules worth testing here — **`Verified` needs a method**, **every
 * outcome needs evidence**, and **an emailed link cannot revoke** — are table tests rather
 * than things only reachable by posting a form to a route behind a signed token.
 *
 * ## The `allowed` argument is the "no revoke button" rule
 *
 * The set of outcomes a caller may submit is passed in rather than read from a constant
 * here, so that the decision page passes `DECIDABLE_OUTCOMES` and the off-link revocation
 * endpoint passes `HAND_ONLY_OUTCOMES`. That is ADR 0002's "revocation is deliberately not
 * on a signed link" expressed as a parameter: the page's parser physically cannot return a
 * `Revoked` outcome, whatever its form is hand-edited to submit, and the check is in the one
 * place both callers go through rather than in an `if` in each route that a later edit could
 * drop from one of them.
 */

import type { VerificationOutcome } from "@pawster/domain";
import type { VerificationMethod } from "./policy.ts";
import {
  MAX_EVIDENCE,
  MIN_EVIDENCE,
  /**
   * The canonical order methods are stored and rendered in. Imported as a value rather than
   * re-listed here, so the order an entry is written in and the order the decision page
   * shows are the same list.
   */
  VERIFICATION_METHODS as METHOD_ORDER,
  isVerificationMethod,
  requiresMethod,
} from "./policy.ts";

/** Rendered as one message each; the field name is the form control to point at. */
export interface DecisionError {
  readonly field: "outcome" | "methods" | "evidence";
  readonly reason: string;
}

export interface DecisionInput {
  readonly outcome: VerificationOutcome;
  /** In {@link VERIFICATION_METHODS}' own order, de-duplicated. */
  readonly methods: readonly VerificationMethod[];
  readonly evidence: string;
}

export type DecisionParse =
  | { readonly ok: true; readonly value: DecisionInput }
  | { readonly ok: false; readonly errors: readonly DecisionError[] };

/**
 * Every problem at once rather than the first one, matching the two shelter-facing parsers.
 * The admin is one person on a phone at 11pm (ADR 0002's own picture of this moment), and a
 * form that reports one error per submission is a form that gets abandoned there.
 */
export function parseDecision(
  form: FormData,
  allowed: readonly VerificationOutcome[],
): DecisionParse {
  const errors: DecisionError[] = [];

  const submittedOutcome = readTrimmed(form, "outcome");
  const outcome = allowed.find((candidate) => candidate === submittedOutcome);
  if (!outcome) {
    errors.push({
      field: "outcome",
      reason: `Choose one of: ${allowed.join(", ")}.`,
    });
  }

  /**
   * De-duplicated **and reordered into the vocabulary's own order**, so that two entries
   * naming the same two methods hold the same string. Without it the column would be
   * comparable only after parsing, and a checkbox list re-ordered in the template would
   * silently change how existing-looking entries are written.
   */
  const submittedMethods = new Set(
    form.getAll("methods").filter((value): value is string => typeof value === "string"),
  );
  const methods: VerificationMethod[] = [];
  for (const value of submittedMethods) {
    if (!isVerificationMethod(value)) {
      errors.push({
        field: "methods",
        reason: "One of the methods submitted is not a method this platform has.",
      });
      break;
    }
  }
  for (const method of METHOD_ORDER) {
    if (submittedMethods.has(method)) methods.push(method);
  }

  if (outcome && requiresMethod(outcome) && methods.length === 0) {
    errors.push({
      field: "methods",
      reason:
        "Say how you checked. A verification with no method recorded is the flag flip " +
        "ADR 0002 refused to build.",
    });
  }

  const evidence = readTrimmed(form, "evidence");
  if (evidence.length < MIN_EVIDENCE) {
    errors.push({
      field: "evidence",
      reason:
        "Write down what you saw. An entry with no evidence cannot answer an appeal, " +
        "which is the whole reason the log exists (ADR 0003).",
    });
  } else if (evidence.length > MAX_EVIDENCE) {
    errors.push({
      field: "evidence",
      reason: `Evidence cannot pass ${MAX_EVIDENCE} characters.`,
    });
  }

  if (errors.length > 0 || !outcome) {
    return { ok: false, errors };
  }

  return { ok: true, value: { outcome, methods, evidence } };
}

function readTrimmed(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The stored form of a method set: a comma-separated list of keys in the vocabulary's order.
 *
 * See `db/src/schema.ts` for why a comma list and not JSON — every member is a fixed key
 * from a closed vocabulary, so the encoding cannot be broken by its own contents.
 */
export function encodeMethods(methods: readonly VerificationMethod[]): string {
  return methods.join(",");
}

/**
 * The reverse, dropping anything the vocabulary no longer has.
 *
 * Dropping rather than throwing, because this reads *history*: a method removed from the
 * platform must not make an old entry unreadable, and the decision page's job when it meets
 * one is to show the rest of a real judgement rather than a 500.
 */
export function decodeMethods(stored: string): readonly VerificationMethod[] {
  return stored
    .split(",")
    .map((value) => value.trim())
    .filter(isVerificationMethod);
}
