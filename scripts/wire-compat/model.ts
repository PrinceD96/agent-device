/**
 * Does the daemon RPC wire surface's drift since the last RELEASED version
 * carry the justification ADR 0006 requires? (#1432)
 *
 * Pure comparison, no git and no filesystem, so the bump / ack / removal rules
 * are provable from fixtures instead of only from whatever the repository's
 * tags happen to contain today — the `scripts/<name>/{model,run}.ts` split
 * check-affected and coverage-changed already use.
 *
 * Division of labour with the unit lane: `test/wire-compat/wire-compat.test.ts`
 * ties the ledger to the SOURCE it describes (and to
 * `DAEMON_RPC_PROTOCOL_VERSION`), which is why nothing here re-checks that.
 * This model only ties one ledger to another.
 */

import type { WireLedger } from '../../test/wire-compat/ledger.ts';

export type WireComparisonInput = {
  /** Released tag the baseline ledger came from, for failure messages. */
  baselineTag: string;
  released: WireLedger;
  current: WireLedger;
  /** Digests recomputed from today's source, keyed `<file>#<name>`. */
  digests: ReadonlyMap<string, string>;
};

export type WireComparison = {
  /** Declarations whose digest moved since the baseline. */
  changed: readonly string[];
  /** Declarations the baseline had and the current wire surface does not. */
  removed: readonly string[];
  /**
   * Baseline declarations that left their path but were re-declared unchanged
   * (same name, same digest) at another path: a file move, never a failure.
   */
  moved: readonly string[];
  /**
   * Current keys the baseline never had (pure-move destinations excepted —
   * their source is reported in `moved` instead). Additive, so never a failure.
   */
  added: readonly string[];
  /** Whether the protocol version advanced since the baseline. */
  bumped: boolean;
  /** Empty when the drift is justified. */
  failures: readonly string[];
};

export function compareWireLedgers(input: WireComparisonInput): WireComparison {
  const { baselineTag, released, current, digests } = input;
  const bumped = current.protocolVersion > released.protocolVersion;

  const changed: string[] = [];
  const removed: string[] = [];
  const moved: string[] = [];
  const movedDestinations = new Set<string>();
  const releasedKeys = new Set(Object.keys(released.declarations));
  for (const [key, releasedDigest] of Object.entries(released.declarations)) {
    const fate = baselineKeyFate(key, releasedDigest, digests, releasedKeys);
    if (fate.kind === 'changed') changed.push(fate.reportKey);
    else if (fate.kind === 'moved') {
      moved.push(key);
      movedDestinations.add(fate.destination);
    } else if (fate.kind === 'removed') removed.push(key);
  }
  const added = Object.keys(current.declarations).filter(
    (key) => !(key in released.declarations) && !movedDestinations.has(key),
  );

  const failures: string[] = [];
  const stillAt = `still ${current.protocolVersion}`;

  // A declaration the released wire surface had and this one does not is a
  // break by definition: a peer on the old protocol can still send it. There is
  // no additive reading of a removal, so no ack can cover one — only a bump.
  if (removed.length > 0 && !bumped) {
    failures.push(
      `Dropped since ${baselineTag} without bumping DAEMON_RPC_PROTOCOL_VERSION (${stillAt}):\n` +
        `${removed.map((key) => `  - ${key}`).join('\n')}\n` +
        `  Removing wire surface a released peer still sends is breaking; an ack cannot cover it.`,
    );
  }

  if (changed.length > 0 && !bumped) {
    // An ack is keyed by the digest the declaration moved TO, so it covers one
    // specific post-change shape and cannot be recycled for the next change.
    const acked = new Map(current.compatibleChanges.map((ack) => [ack.declaration, ack]));
    const unacked = changed.filter((key) => {
      const ack = acked.get(key);
      return ack?.digest !== digests.get(key) || ack.rationale.trim().length === 0;
    });
    if (unacked.length > 0) {
      failures.push(
        `Changed since ${baselineTag} without bumping DAEMON_RPC_PROTOCOL_VERSION (${stillAt}):\n` +
          `${unacked.map((key) => `  - ${key}`).join('\n')}\n` +
          `  Read ADR 0006. If a peer on protocol ${released.protocolVersion} would misinterpret ` +
          `the new payload, bump the constant and the ledger's protocolVersion. If the change is ` +
          `additive — a new optional field the other side ignores — add a compatibleChanges entry ` +
          `per declaration carrying its current digest and the reason it stays compatible. ` +
          `test/wire-compat/README.md walks both.`,
      );
    }
  }

  return { changed, removed, moved, added, bumped, failures };
}

type BaselineFate =
  | { kind: 'unchanged' }
  | { kind: 'changed'; reportKey: string }
  | { kind: 'moved'; destination: string }
  | { kind: 'removed' };

/**
 * What a baseline declaration became in the current surface.
 *
 * A declaration that left its path is a removal UNLESS it re-appears,
 * unchanged, at exactly one new path — a file move, which a released peer
 * still parses. A same-name re-declaration whose digest MOVED is a CHANGE at
 * the destination: textually it is indistinguishable from "the baseline
 * declaration was removed and a new same-named one appeared", so that reading
 * is ackable (digest-pinned, rationale required) rather than bump-forcing.
 * Matching is limited to candidates absent from the baseline itself: names are
 * not unique across files (two files both declare `sendJson`), and a name that
 * a baseline declaration still owns at its own path cannot identify a move.
 */
function baselineKeyFate(
  key: string,
  releasedDigest: string,
  digests: ReadonlyMap<string, string>,
  releasedKeys: ReadonlySet<string>,
): BaselineFate {
  const digest = digests.get(key);
  if (digest !== undefined) {
    return digest === releasedDigest ? { kind: 'unchanged' } : { kind: 'changed', reportKey: key };
  }
  const name = declarationName(key);
  const candidates = [...digests.keys()].filter(
    (candidate) =>
      candidate !== key && declarationName(candidate) === name && !releasedKeys.has(candidate),
  );
  if (candidates.length !== 1) return { kind: 'removed' };
  const candidate = candidates[0]!;
  return digests.get(candidate) === releasedDigest
    ? { kind: 'moved', destination: candidate }
    : { kind: 'changed', reportKey: candidate };
}

/** The declaration name in a `<file>#<name>` key. */
function declarationName(key: string): string {
  const separator = key.lastIndexOf('#');
  return separator >= 0 ? key.slice(separator + 1) : key;
}
