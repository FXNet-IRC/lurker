// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { parseTruthyEnv } from './truthyEnv.js';

/**
 * Whether link previews and inline media exist on this instance at all.
 *
 * ⚠ A FEATURE FLAG, defaulting to OFF — not merely a fetch switch. When it's off the routes
 * aren't mounted, the resolver never runs, and both clients hide the two user settings rather
 * than offering toggles that do nothing. A visible switch that silently has no effect is worse
 * than no switch.
 *
 * Off by default because this is the one feature that makes the server dial arbitrary
 * user-supplied URLs. That's the operator's bandwidth, the operator's IP reputation, and the
 * operator's problem if someone points a channel at something — so it should be a decision
 * somebody made, not something an upgrade turns on. The Lounge reaches the same conclusion for
 * the same reason (`prefetch: false` in its shipped defaults).
 *
 * The two per-user settings remain independent and also default off: this decides whether the
 * instance participates, those decide whether *you* see previews.
 *
 * ⚠ Lives in `utils/` beside `edition.ts` rather than in the resolver it gates. `app.ts` and
 * `routes/config.ts` both need the answer, and neither should have to pull the resolver — with
 * its sharp, sqlite and http agents — into its module graph to read one environment variable.
 */
export function previewsEnabled(): boolean {
  // Shares DCC's parser rather than hand-rolling a fifth truthy-env test in this codebase.
  // Same conventional set, already unit-tested, and an operator who learns the convention once
  // shouldn't find that `on` works for one flag and not another.
  return parseTruthyEnv(process.env.LURKER_LINK_PREVIEWS);
}
