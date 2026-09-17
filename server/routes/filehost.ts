// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// soju.im/FILEHOST: where an IRC client attached to the bouncer uploads a file
// (soju's doc/ext/filehost.md). The bouncer advertises this URL in ISUPPORT; the
// client POSTs the raw file with the credentials of its IRC connection and puts
// the URL we answer with into its composer. goguma, gamja and halloy use it.
//
// It runs the same pipeline as POST /api/uploads (services/uploadService.ts):
// the user's default uploader, the same cap, the same accepted types, images
// re-encoded and media scrubbed, and a row in the uploads list.
//
// What differs is at the edges:
//   - Auth comes only from the Authorization header, never a cookie: HTTP Basic
//     with a bouncer login (the password or a read-write API token, or an OAuth
//     token as the password), or Bearer with an OAuth token.
//   - The body is the file itself, not multipart, streamed to a temp file.
//   - Success is 201 with a Location, which goguma and halloy require exactly,
//     and errors are text/plain, which is what goguma will show.
//   - CORS is open to any origin: with no cookie accepted, a page can only upload
//     with credentials it sets itself. gamja needs Location exposed.

import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { User } from '../db/users.js';
import { findUserByUsername } from '../db/users.js';
import { findTokenByRaw, touchTokenLastUsed } from '../db/oauth.js';
import { loadBearerCredential } from '../middleware/auth.js';
import { clientIp, loginFailureThrottle } from '../middleware/rateLimit.js';
import { verifyBouncerLogin } from '../services/bouncerLogin.js';
import { unmarshalLogin } from '../services/bouncer.js';
import { effectiveUploadCapBytes, formatCapMb } from '../services/uploadLimits.js';
import { acceptedMediaMimes } from '../services/contentClass.js';
import {
  processUpload,
  UploadRequestError,
  UPLOAD_TMP_DIR,
  uploadTempName,
} from '../services/uploadService.js';
import { publicBaseUrl } from '../utils/publicOrigin.js';

const router = Router();

const ACCEPT_POST = ['image/*', 'text/*', ...acceptedMediaMimes()].join(', ');

function sendText(res: Response, status: number, text: string): void {
  res.status(status).type('text/plain').send(text);
}

// How much of a refused body is read and thrown away before the connection is
// closed anyway.
const LINGER_BYTES = 4 * 1024 * 1024;
const LINGER_MS = 10_000;

// An answer sent before the body is read. The connection stays open while the
// rest arrives and is thrown away, so the client finishes writing and reads the
// answer: closing at once made its next write fail, and a client that fails to
// write can report a reset instead of the 413. Node would read an unread body
// to the end on its own; past LINGER_BYTES or LINGER_MS this closes it, so a
// file far over the cap isn't taken in full just to say no.
function refuse(req: Request, res: Response, status: number, text: string): void {
  sendText(res, status, text);
  if (req.complete) return;
  let drained = 0;
  const close = () => req.socket.destroy();
  const timer = setTimeout(close, LINGER_MS);
  timer.unref();
  req.on('data', (chunk: Buffer) => {
    drained += chunk.length;
    if (drained > LINGER_BYTES) close();
  });
  req.on('close', () => clearTimeout(timer));
  req.resume();
}

router.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (origin) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Access-Control-Allow-Credentials', 'true');
    res.vary('Origin');
  }
  res.set('Access-Control-Allow-Methods', 'OPTIONS, POST');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Content-Disposition');
  res.set('Access-Control-Expose-Headers', 'Location');
  next();
});

router.options('/', (_req: Request, res: Response) => {
  res.set('Allow', 'OPTIONS, POST');
  res.set('Accept-Post', ACCEPT_POST);
  res.status(204).end();
});

/**
 * The account an Authorization header signs in as, or null. Basic carries a
 * bouncer login: the username may keep the `/network` or `@client` a client
 * typed for IRC, as soju allows. Its password is the account password, a
 * read-write API token, or an OAuth token. Bearer carries an OAuth token.
 */
export function filehostUser(authorization: string | undefined): User | null {
  if (!authorization) return null;
  const basic = /^Basic\s+(\S+)$/i.exec(authorization);
  if (!basic) return loadBearerCredential(authorization)?.user ?? null;
  const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon <= 0) return null;
  const username = unmarshalLogin(decoded.slice(0, colon)).username;
  const secret = decoded.slice(colon + 1);
  if (!username || !secret) return null;
  const login = verifyBouncerLogin(username, secret);
  if (login) return login.user;
  // An OAuth token names its user; it counts only for the user the header names.
  const oauth = findTokenByRaw(secret);
  const user = oauth ? findUserByUsername(username) : undefined;
  if (!oauth || !user || user.id !== oauth.userId) return null;
  touchTokenLastUsed(oauth.id);
  return user;
}

/**
 * The filename a Content-Disposition names, parsed leniently: clients get the
 * encoding wrong in ways a strict parser refuses. gamja leaves `'()` unescaped
 * in `filename*`, and goguma encodes spaces there as `+`. `filename*` wins over
 * `filename`, and any directory part is dropped.
 */
export function dispositionFilename(header: string | undefined): string {
  if (!header) return '';
  let name = '';
  const extended = /filename\*\s*=\s*([^;]*)/i.exec(header);
  if (extended) {
    const value = extended[1].trim().replace(/^"(.*)"$/, '$1');
    const encoded = value.replace(/^[^']*'[^']*'/, '');
    try {
      name = decodeURIComponent(encoded.replace(/\+/g, ' '));
    } catch {
      name = encoded;
    }
  }
  if (!name) {
    const quoted = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(header);
    const bare = /filename\s*=\s*([^";]+)/i.exec(header);
    if (quoted) name = quoted[1].replace(/\\(.)/g, '$1');
    else if (bare) name = bare[1].trim();
  }
  return name.split(/[/\\]/).pop()!.trim().slice(0, 255);
}

class TooLargeError extends Error {}
class InterruptedError extends Error {}

// Stream the body to `dest`, failing once it passes `capBytes`. Not
// stream.pipeline: that destroys the request on an error, which closes the
// connection before the 413 can be read (see refuse).
function receiveBody(req: Request, dest: string, capBytes: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest, { mode: 0o600 });
    let received = 0;
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      req.unpipe(out);
      out.destroy();
      reject(err);
    };
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > capBytes) fail(new TooLargeError());
    });
    req.on('close', () => {
      if (!req.complete) fail(new InterruptedError());
    });
    out.on('error', fail);
    out.on('finish', () => {
      if (settled) return;
      settled = true;
      resolve(received);
    });
    req.pipe(out);
  });
}

// Not an async handler: Express 5 turns a rejection out of one into an unhandled
// rejection rather than a response, so the body answers its own failures.
router.post('/', (req: Request, res: Response) => {
  void receiveUpload(req, res);
});

async function receiveUpload(req: Request, res: Response): Promise<void> {
  try {
    await handleUpload(req, res);
  } catch (err) {
    console.error('[lurker] filehost upload failed:', err);
    if (!res.headersSent) sendText(res, 500, 'upload failed');
  }
}

async function handleUpload(req: Request, res: Response): Promise<void> {
  // Failed logins count toward the same per-IP budget as the web sign-in.
  const key = clientIp(req);
  const retry = key === null ? null : loginFailureThrottle.retryAfter(key);
  if (retry !== null) {
    res.set('Retry-After', String(retry));
    refuse(req, res, 429, 'too many failed logins — try again later');
    return;
  }

  const user = filehostUser(req.headers.authorization);
  if (!user) {
    if (key !== null) loginFailureThrottle.recordFailure(key);
    res.set('WWW-Authenticate', 'Basic realm="Lurker", charset="UTF-8"');
    refuse(req, res, 401, 'invalid or missing credentials');
    return;
  }
  if (key !== null) loginFailureThrottle.reset(key);
  if (user.is_paused) {
    refuse(req, res, 403, 'account paused');
    return;
  }

  const isAdmin = user.role === 'admin';
  const capBytes = effectiveUploadCapBytes(user.id, isAdmin);
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > capBytes) {
    refuse(req, res, 413, `file exceeds ${formatCapMb(capBytes)} MB`);
    return;
  }

  const tempPath = path.join(UPLOAD_TMP_DIR, uploadTempName());
  try {
    let size: number;
    try {
      size = await receiveBody(req, tempPath, capBytes);
    } catch (err) {
      if (err instanceof TooLargeError) {
        refuse(req, res, 413, `file exceeds ${formatCapMb(capBytes)} MB`);
        return;
      }
      // The client went away mid-upload: there's no one to answer.
      if (err instanceof InterruptedError) return;
      throw err;
    }
    if (size === 0) {
      sendText(res, 400, 'no file uploaded');
      return;
    }
    const uploaded = await processUpload({
      userId: user.id,
      isAdmin,
      tempPath,
      size,
      claimedMime: (req.headers['content-type'] ?? '').split(';')[0].trim(),
      originalName: dispositionFilename(req.headers['content-disposition']),
      requestedUploaderId: null,
      progressToken: null,
      baseUrl: () => publicBaseUrl(req),
    });
    res.location(uploaded.url);
    sendText(res, 201, uploaded.url);
  } catch (err) {
    if (err instanceof UploadRequestError) {
      sendText(res, err.status, err.message);
      return;
    }
    throw err;
  } finally {
    await fs.promises.unlink(tempPath).catch(() => {});
  }
}

export default router;
