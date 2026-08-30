// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { previewsEnabled, warnRetiredPreviewEnv } from './previews.js';

describe('previewsEnabled', () => {
  const withUrl = (value: string | undefined, run: () => void) => {
    const saved = process.env.LURKER_PREVIEWS_URL;
    if (value === undefined) delete process.env.LURKER_PREVIEWS_URL;
    else process.env.LURKER_PREVIEWS_URL = value;
    try {
      run();
    } finally {
      if (saved === undefined) delete process.env.LURKER_PREVIEWS_URL;
      else process.env.LURKER_PREVIEWS_URL = saved;
    }
  };

  it('defaults OFF — an upgrade with no decoder configured dials nothing', () => {
    // The whole feature is the decoder: no LURKER_PREVIEWS_URL, no previews. An operator who
    // upgrades and does nothing gets a server that never reaches out. The Lounge ships
    // `prefetch: false` for the same reason.
    withUrl(undefined, () => expect(previewsEnabled()).toBe(false));
    // Present-but-empty (or whitespace) is not "configured" — it's the unset state spelled
    // a different way, which is exactly how a half-written compose file arrives.
    withUrl('', () => expect(previewsEnabled()).toBe(false));
    withUrl('   ', () => expect(previewsEnabled()).toBe(false));
  });

  it('is enabled by a configured decoder URL — the presence IS the gate', () => {
    withUrl('http://lurker-previews:8030', () => expect(previewsEnabled()).toBe(true));
    withUrl('http://127.0.0.1:8030', () => expect(previewsEnabled()).toBe(true));
  });
});

// ⚠ The reason this exists: `LURKER_LINK_PREVIEWS=on` SHIPPED in 2.1.0 and 2.1.1 (it is in
// .env.example on both tags), so upgraders have it set and working. After the decoder split
// nothing reads it — previews just stop, with nothing in the log to explain why, and the fix
// is not a rename they could guess but a second container. The warning is the only signal
// that reaches an operator who didn't read the release notes.
describe('warnRetiredPreviewEnv', () => {
  const withEnv = (env: Record<string, string | undefined>, run: (lines: string[]) => void) => {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    const lines: string[] = [];
    try {
      warnRetiredPreviewEnv((m) => lines.push(m));
      run(lines);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  it('says nothing when no retired variable is set', () => {
    withEnv(
      {
        LURKER_LINK_PREVIEWS: undefined,
        LURKER_PREVIEW_USER_AGENT: undefined,
        LURKER_PREVIEWS_URL: undefined,
      },
      (lines) => expect(lines).toEqual([]),
    );
  });

  // The case the whole thing is for: they asked for previews, previews are off, and without
  // this the only symptom is "it stopped working".
  it('names the replacement when the old flag is set and previews are OFF', () => {
    withEnv(
      {
        LURKER_LINK_PREVIEWS: 'on',
        LURKER_PREVIEW_USER_AGENT: undefined,
        LURKER_PREVIEWS_URL: undefined,
      },
      (lines) => {
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('LURKER_LINK_PREVIEWS');
        expect(lines[0]).toContain('LURKER_PREVIEWS_URL');
        expect(lines[0]).toContain('no longer read');
      },
    );
  });

  it('points LURKER_PREVIEW_USER_AGENT at the decoder, not at the new URL', () => {
    withEnv(
      {
        LURKER_LINK_PREVIEWS: undefined,
        LURKER_PREVIEW_USER_AGENT: 'MyBot/1.0',
        LURKER_PREVIEWS_URL: undefined,
      },
      (lines) => {
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('LURKER_PREVIEW_USER_AGENT');
        expect(lines[0]).toContain('decoder');
      },
    );
  });

  // Already migrated but left the old line in their env file. Nothing is broken, so this is a
  // tidy-up note rather than a per-variable alarm about a feature that is plainly working.
  it('downgrades to one leftover-litter line once previews are ON', () => {
    withEnv(
      {
        LURKER_LINK_PREVIEWS: 'on',
        LURKER_PREVIEW_USER_AGENT: 'MyBot/1.0',
        LURKER_PREVIEWS_URL: 'http://lurker-previews:8030',
      },
      (lines) => {
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('can be removed');
        expect(lines[0]).toContain('LURKER_LINK_PREVIEWS');
        expect(lines[0]).toContain('LURKER_PREVIEW_USER_AGENT');
      },
    );
  });

  // Present-but-empty is how a compose file spells "unset"; it must not trip an alarm.
  it('treats an empty value as unset', () => {
    withEnv(
      {
        LURKER_LINK_PREVIEWS: '   ',
        LURKER_PREVIEW_USER_AGENT: undefined,
        LURKER_PREVIEWS_URL: undefined,
      },
      (lines) => expect(lines).toEqual([]),
    );
  });
});
