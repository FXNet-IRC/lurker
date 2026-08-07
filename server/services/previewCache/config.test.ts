// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, afterEach } from 'vitest';
import { resolveCacheConfig } from './config.js';

const KEYS = [
  'LURKER_PREVIEW_CACHE_MODE',
  'LURKER_PREVIEW_CACHE_DIR',
  'LURKER_PREVIEW_CACHE_MAX_BYTES',
  'LURKER_PREVIEW_CACHE_S3_ENDPOINT',
  'LURKER_PREVIEW_CACHE_S3_BUCKET',
  'LURKER_PREVIEW_CACHE_S3_REGION',
  'LURKER_PREVIEW_CACHE_S3_ACCESS_KEY_ID',
  'LURKER_PREVIEW_CACHE_S3_SECRET_ACCESS_KEY',
  'LURKER_PREVIEW_CACHE_S3_PUBLIC_BASE_URL',
  'LURKER_PREVIEW_CACHE_S3_PREFIX',
];

/** Every field `s3` requires, so a test can remove exactly one. */
function setS3Env(): void {
  process.env.LURKER_PREVIEW_CACHE_MODE = 's3';
  process.env.LURKER_PREVIEW_CACHE_S3_ENDPOINT = 'https://accountid.r2.cloudflarestorage.com';
  process.env.LURKER_PREVIEW_CACHE_S3_BUCKET = 'previews';
  process.env.LURKER_PREVIEW_CACHE_S3_ACCESS_KEY_ID = 'key';
  process.env.LURKER_PREVIEW_CACHE_S3_SECRET_ACCESS_KEY = 'secret';
  process.env.LURKER_PREVIEW_CACHE_S3_PUBLIC_BASE_URL = 'https://cdn.example.com';
}

afterEach(() => {
  for (const k of KEYS) delete process.env[k];
});

describe('resolveCacheConfig', () => {
  it('is off when nothing is set, which is the shipped default', () => {
    expect(resolveCacheConfig().mode).toBe('off');
    process.env.LURKER_PREVIEW_CACHE_MODE = 'off';
    expect(resolveCacheConfig().mode).toBe('off');
  });

  it('rejects an unknown mode rather than guessing at it, and says so', () => {
    for (const mode of ['r2', 'bucket', 'dropper']) {
      process.env.LURKER_PREVIEW_CACHE_MODE = mode;
      const warnings: string[] = [];
      expect(`${mode} → ${resolveCacheConfig((m) => warnings.push(m)).mode}`).toBe(`${mode} → off`);
      expect(warnings.join(' ')).toMatch(/caching is OFF/);
    }
  });

  it('defaults the local directory and ceiling', () => {
    process.env.LURKER_PREVIEW_CACHE_MODE = 'local';
    const cfg = resolveCacheConfig();
    if (cfg.mode !== 'local') throw new Error('unreachable');
    expect(cfg.dir).toMatch(/preview-cache$/);
    expect(cfg.maxBytes).toBe(2 * 1024 * 1024 * 1024);
  });

  it('takes a plain byte count, and refuses anything that is not one', () => {
    process.env.LURKER_PREVIEW_CACHE_MODE = 'local';
    const DEFAULT = 2 * 1024 * 1024 * 1024;

    process.env.LURKER_PREVIEW_CACHE_MAX_BYTES = '1048576';
    const set = resolveCacheConfig();
    if (set.mode !== 'local') throw new Error('unreachable');
    expect(set.maxBytes).toBe(1048576);

    // ⚠ `parseInt` would take '2GB' and hand back 2 — a two-byte cache that evicts
    // everything it stores and reads as "caching is broken". A number past
    // MAX_SAFE_INTEGER is refused for the mirror-image reason: the eviction
    // arithmetic stops being exact, and a silently wrong answer about whether we
    // are over the ceiling is worse than no answer.
    for (const bad of ['2GB', '-1', '0', 'lots', '1.5', '1e9', '99999999999999999999']) {
      process.env.LURKER_PREVIEW_CACHE_MAX_BYTES = bad;
      const warnings: string[] = [];
      const cfg = resolveCacheConfig((m) => warnings.push(m));
      if (cfg.mode !== 'local') throw new Error('unreachable');
      expect(`${bad} → ${cfg.maxBytes}`).toBe(`${bad} → ${DEFAULT}`);
      // ...and never silently, or an operator debugs a cache that looks like it is
      // ignoring the setting they just wrote.
      expect(`${bad}: ${warnings.length > 0 ? 'warned' : 'silent'}`).toBe(`${bad}: warned`);
    }
  });

  it('honours an explicit cache directory', () => {
    process.env.LURKER_PREVIEW_CACHE_MODE = 'local';
    process.env.LURKER_PREVIEW_CACHE_DIR = '/tmp/somewhere-else';
    const cfg = resolveCacheConfig();
    if (cfg.mode !== 'local') throw new Error('unreachable');
    expect(cfg.dir).toBe('/tmp/somewhere-else');
  });

  describe('mode s3', () => {
    it('resolves a complete config', () => {
      setS3Env();
      process.env.LURKER_PREVIEW_CACHE_S3_PREFIX = 'previews';
      const cfg = resolveCacheConfig();
      if (cfg.mode !== 's3') throw new Error('unreachable');
      expect(cfg.bucket).toBe('previews');
      expect(cfg.prefix).toBe('previews');
      expect(cfg.publicBaseUrl).toBe('https://cdn.example.com');
      // R2 wants literally "auto"; the uploader defaults the same way.
      expect(cfg.region).toBe('auto');
    });

    it('falls back to OFF, loudly, when any required field is missing', () => {
      // ⚠ A half-configured bucket does not degrade to slow — it degrades to a
      // descriptor handing out public URLs that 404 for everyone. Every field is
      // load-bearing, so a missing one has to stop the mode rather than be defaulted.
      for (const key of [
        'LURKER_PREVIEW_CACHE_S3_ENDPOINT',
        'LURKER_PREVIEW_CACHE_S3_BUCKET',
        'LURKER_PREVIEW_CACHE_S3_ACCESS_KEY_ID',
        'LURKER_PREVIEW_CACHE_S3_SECRET_ACCESS_KEY',
        'LURKER_PREVIEW_CACHE_S3_PUBLIC_BASE_URL',
      ]) {
        setS3Env();
        delete process.env[key];
        const warnings: string[] = [];
        const cfg = resolveCacheConfig((m) => warnings.push(m));
        expect(`${key} → ${cfg.mode}`).toBe(`${key} → off`);
        expect(`${key}: ${warnings.length > 0 ? 'warned' : 'silent'}`).toBe(`${key}: warned`);
        // The warning has to NAME the field, or an operator with five env vars set
        // is told only that something is wrong.
        expect(`${key} named: ${warnings.some((w) => w.includes(key))}`).toBe(`${key} named: true`);
      }
    });

    it('refuses a public base URL that is not https', () => {
      // ⚠⚠ These URLs are handed to browsers as image sources on an https page,
      // where an http image is blocked as mixed content and simply never renders.
      // Caught at boot, this is one warning; uncaught, it is every cached preview
      // silently going blank with nothing in any log.
      for (const bad of ['http://cdn.example.com', 'ftp://cdn.example.com', 'not a url', '//cdn']) {
        setS3Env();
        process.env.LURKER_PREVIEW_CACHE_S3_PUBLIC_BASE_URL = bad;
        const warnings: string[] = [];
        const cfg = resolveCacheConfig((m) => warnings.push(m));
        expect(`${bad} → ${cfg.mode}`).toBe(`${bad} → off`);
        expect(`${bad}: ${warnings.length > 0 ? 'warned' : 'silent'}`).toBe(`${bad}: warned`);
      }
    });

    it('sanitises the key prefix, per segment', () => {
      // ⚠⚠ The prefix reaches `new URL()` and an S3 key. Left raw, a '#' in it
      // truncates the signed URL at the fragment — so EVERY object PUTs to the SAME
      // key and one person's picture serves under another's URL. `sanitizeSegment`
      // sat unused in the uploader's module while exactly this shipped once.
      const cases: Array<[string, string]> = [
        ['previews', 'previews'],
        ['a/b', 'a/b'],
        ['pre#fix', 'prefix'],
        ['pre?fix', 'prefix'],
        ['../../etc', 'etc'],
        ['a//b', 'a/b'],
        ['/leading/', 'leading'],
        ['pre fix', 'prefix'],
        ['', ''],
      ];
      for (const [raw, want] of cases) {
        setS3Env();
        process.env.LURKER_PREVIEW_CACHE_S3_PREFIX = raw;
        const cfg = resolveCacheConfig();
        if (cfg.mode !== 's3') throw new Error('unreachable');
        expect(`${JSON.stringify(raw)} → ${cfg.prefix}`).toBe(`${JSON.stringify(raw)} → ${want}`);
      }
    });

    it('trims trailing slashes so keys never double up a separator', () => {
      setS3Env();
      process.env.LURKER_PREVIEW_CACHE_S3_ENDPOINT = 'https://endpoint.example.com/';
      process.env.LURKER_PREVIEW_CACHE_S3_PUBLIC_BASE_URL = 'https://cdn.example.com//';
      const cfg = resolveCacheConfig();
      if (cfg.mode !== 's3') throw new Error('unreachable');
      expect(cfg.endpoint).toBe('https://endpoint.example.com');
      expect(cfg.publicBaseUrl).toBe('https://cdn.example.com');
    });
  });
});
