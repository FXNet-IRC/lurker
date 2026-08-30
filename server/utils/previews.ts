// Copyright (c) 2026 Brad Root

// SPDX-License-Identifier: MPL-2.0

/**
 * Whether link previews and inline media exist on this instance at all.
 *
 * ⚠ The presence of `LURKER_PREVIEWS_URL` IS the feature flag, and that is the whole gate —
 * there is no separate on/off switch. It reads oddly until you see why: previews are resolved
 * by the `lurker-previews` decoder (a second container), and pointing at one is the only way
 * the feature can function at all. So "is a decoder configured" and "is the feature on" are the
 * same question, and a single knob cannot express the one broken state a second one could — a
 * feature switched on with nowhere to resolve, every preview failing forever.
 *
 * This preserves the property the old `LURKER_LINK_PREVIEWS` flag existed for: previews are the
 * one feature that makes the instance dial arbitrary user-supplied URLs, so turning them on must
 * be a deliberate operator act rather than something an upgrade inherits. Standing up a decoder
 * and naming it here is exactly that act — you cannot arrive at it by accident, which is the
 * same bar the explicit flag set, reached with one fewer thing to keep in sync. Off by default
 * because an unset URL is off.
 *
 * The two per-user settings remain independent and also default off: this decides whether the
 * instance participates, those decide whether *you* see previews. When this is off the routes
 * aren't mounted, the resolver never runs, and both clients hide those two settings rather than
 * offering toggles that do nothing.
 *
 * ⚠ Lives in `utils/` beside `edition.ts` rather than in the resolver it gates. `app.ts` and
 * `routes/config.ts` both need the answer, and neither should have to pull the resolver — with
 * its sqlite and http agents — into its module graph to read one environment variable.
 */
export function previewsEnabled(): boolean {
  return !!process.env.LURKER_PREVIEWS_URL?.trim();
}

// Variables that configured previews before the decoder split (2.1.2) and are now read by
// NOTHING on this server. Each maps to what replaced it.
const RETIRED_PREVIEW_ENV: Array<{ name: string; advice: string }> = [
  {
    name: 'LURKER_LINK_PREVIEWS',
    advice:
      'previews are enabled by pointing LURKER_PREVIEWS_URL at a lurker-previews decoder container',
  },
  {
    name: 'LURKER_PREVIEW_USER_AGENT',
    advice: 'this moved to the decoder — set it on the lurker-previews container instead',
  },
];

/**
 * Warn at startup about preview settings that used to do something and no longer do.
 *
 * ⚠ This exists because the 2.1.2 upgrade is otherwise SILENT for the operators it affects most.
 * `LURKER_LINK_PREVIEWS=on` shipped in 2.1.0 and 2.1.1, and anyone who set it had working
 * previews; after the decoder split nothing reads it, so previews simply stop and the log says
 * nothing. Worse, the fix is not a rename they could guess — it is standing up a second
 * container. Release notes only reach the people who read them; the server can tell the rest.
 *
 * Two distinct cases, because the severity genuinely differs: a retired variable set while
 * previews are OFF means the feature they asked for is not running, and a retired variable set
 * while previews are ON is just litter in their env file.
 */
export function warnRetiredPreviewEnv(warn: (message: string) => void = console.warn): void {
  const stale = RETIRED_PREVIEW_ENV.filter(({ name }) => !!process.env[name]?.trim());
  if (stale.length === 0) return;

  if (previewsEnabled()) {
    warn(
      `[lurker] ignoring retired preview setting(s): ${stale.map((e) => e.name).join(', ')} — ` +
        'these are no longer read and can be removed from your environment',
    );
    return;
  }
  for (const { name, advice } of stale) {
    warn(
      `[lurker] ${name} is set but is no longer read, and link previews are OFF — ${advice}. ` +
        'See "Link previews & inline media" in docs/SELF_HOSTING.md',
    );
  }
}
