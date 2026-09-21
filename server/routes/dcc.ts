// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// DCC API (#270). Two surfaces: the download manager (list the user's transfers
// and act on them — accept a pending offer, reject it, cancel an in-flight one),
// and DCC CHAT (open or close a direct chat with a peer). The transfer list is
// the Transfers view's initial load; live updates arrive over the WS as
// `dcc-transfer` frames, and a chat's own output arrives as ordinary messages in
// its `=nick` buffer. All routes are user-scoped via requireAuth.

import { Router, type Request, type Response } from 'express';

import { requireAuth } from '../middleware/auth.js';
import ircManager from '../services/ircManager.js';
import { dccEnabledForUser } from '../services/dccConfig.js';
import { getDccTransfer, listDccTransfers } from '../db/dccTransfers.js';
import { getNetwork } from '../db/networks.js';
import { isChannelTarget } from '../../shared/channels.js';

const router = Router();
router.use(requireAuth);

// The two-tier DCC gate (cell master switch AND per-user capability) guards
// every DCC entry point — the inbound-CTCP path checks it, so the API must too,
// or a stale pending_approval row could be accepted after a grant is revoked.
// Gating reads as well as writes keeps the whole surface dark when DCC is off
// (and gives the /dcc command + Transfers modal a clear "not enabled" error).
router.use((req: Request, res: Response, next) => {
  if (!dccEnabledForUser(req.user!.id)) {
    res.status(403).json({ error: 'DCC is not enabled for this account' });
    return;
  }
  next();
});

// A transfer id is a positive integer row id; reject anything else up front so a
// non-numeric :id can't reach better-sqlite3 as NaN (which throws → 500).
function transferId(req: Request): number | null {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** GET /api/dcc — the user's transfers, newest first. */
router.get('/', (req: Request, res: Response) => {
  const limit = req.query.limit ? Number(req.query.limit) : 100;
  res.json({ transfers: listDccTransfers(req.user!.id, { limit }) });
});

// Acting on a transfer is a write — blocked for paused accounts (the list isn't)
// by the central requireAuth gate (#573); the GET list above stays available.

/** POST /api/dcc/:id/accept — accept a pending offer and start the download. */
router.post('/:id/accept', (req: Request, res: Response) => {
  const id = transferId(req);
  if (id == null) {
    res.status(404).json({ error: 'transfer not found' });
    return;
  }
  const result = ircManager.acceptDccTransfer(req.user!.id, id);
  if (result === 'not-found') {
    res.status(404).json({ error: 'transfer not found' });
    return;
  }
  if (result === 'not-pending') {
    res.status(409).json({ error: 'transfer is not awaiting approval' });
    return;
  }
  if (result === 'not-connected') {
    res.status(409).json({ error: 'network not connected' });
    return;
  }
  res.json({ transfer: getDccTransfer(req.user!.id, id) });
});

/** POST /api/dcc/:id/reject — reject a pending offer (no download). */
router.post('/:id/reject', (req: Request, res: Response) => {
  const id = transferId(req);
  if (id == null || !ircManager.rejectDccTransfer(req.user!.id, id)) {
    res.status(404).json({ error: 'transfer not found' });
    return;
  }
  res.json({ transfer: getDccTransfer(req.user!.id, id) });
});

/** POST /api/dcc/:id/cancel — cancel an in-flight or still-pending transfer. */
router.post('/:id/cancel', (req: Request, res: Response) => {
  const id = transferId(req);
  if (id == null || !ircManager.cancelDccTransfer(req.user!.id, id)) {
    res.status(404).json({ error: 'transfer not found' });
    return;
  }
  res.json({ transfer: getDccTransfer(req.user!.id, id) });
});

// {networkId, nick}, ownership-checked. Shared by both chat routes so neither
// can act on a network the caller doesn't own.
function chatTarget(req: Request, res: Response): { networkId: number; nick: string } | null {
  const networkId = Number(req.body?.networkId);
  const nick = typeof req.body?.nick === 'string' ? req.body.nick.trim() : '';
  if (!Number.isInteger(networkId) || networkId <= 0 || !nick) {
    res.status(400).json({ error: 'networkId and nick are required' });
    return null;
  }
  // ⚠ A nick with whitespace would become extra CTCP parameters on the wire;
  // a `=`-prefixed one would name a buffer rather than a peer. Neither is a
  // real nick, so refuse rather than normalise.
  // Matching the control chars is the whole point here — same rule the DCC
  // filename quoter states.
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f]/.test(nick) || nick.startsWith('=')) {
    res.status(400).json({ error: 'not a valid nick' });
    return null;
  }
  // A DCC chat is with a peer. A channel name would broadcast the offer to the
  // whole channel (ircConnection.offerDccChat refuses it too — this is the
  // early, explained refusal).
  if (isChannelTarget(nick)) {
    res.status(400).json({ error: 'a DCC chat is with a person, not a channel' });
    return null;
  }
  if (!getNetwork(networkId, req.user!.id)) {
    res.status(404).json({ error: 'network not found' });
    return null;
  }
  return { networkId, nick };
}

/**
 * POST /api/dcc/chat — offer a DCC chat to a peer. Body: {networkId, nick,
 * passive?}. Returns as soon as the offer is sent; the outcome (connected,
 * refused, timed out) lands in the `=nick` buffer, because a DCC handshake can
 * take as long as the peer takes to answer.
 */
router.post('/chat', (req: Request, res: Response) => {
  const t = chatTarget(req, res);
  if (!t) return;
  const passive = req.body?.passive === true;
  if (!ircManager.dccChatOpen(req.user!.id, t.networkId, t.nick, { passive })) {
    res.status(409).json({ error: 'network not connected' });
    return;
  }
  res.json({ ok: true, target: `=${t.nick}` });
});

/** POST /api/dcc/chat/close — close a live DCC chat. Body: {networkId, nick}. */
router.post('/chat/close', (req: Request, res: Response) => {
  const t = chatTarget(req, res);
  if (!t) return;
  if (!ircManager.dccChatClose(req.user!.id, t.networkId, t.nick)) {
    res.status(404).json({ error: 'no live DCC chat with that peer' });
    return;
  }
  res.json({ ok: true });
});

export default router;
