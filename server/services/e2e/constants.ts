// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Protocol-wide constants for RPE2E01. These are load-bearing for cross-client
// interop: every value here must match repartee's reference implementation
// (and the weechat/Perl scripts) byte-for-byte. See the protocol notes in
// docs and issue #382. Do not "tidy" these without a matching change upstream.

/** Protocol version string embedded in the wire format and the AAD. */
export const PROTO = 'RPE2E01';

/** Wire prefix magic for an encrypted message chunk. */
export const WIRE_PREFIX = '+RPE2E01';

/** CTCP tag for handshake messages (KEYREQ/KEYRSP/REKEY), framed in `\x01..\x01`. */
export const CTCP_TAG = 'RPEE2E';

/** Handshake protocol version (the `v=` field). */
export const PROTO_VERSION = 1;

/** Length of a message id, in bytes. */
export const MSGID_LEN = 8;

/** Max chunks per logical message (hard cap for the sender). */
export const MAX_CHUNKS = 16;

/** Max plaintext bytes per chunk before ciphertext expansion. Chosen so a chunk
 *  fits in ~400 bytes of IRC payload after base64. */
export const MAX_PLAINTEXT_PER_CHUNK = 180;

/** Default replay-protection window for the `ts` field, in seconds. */
export const DEFAULT_TS_TOLERANCE_SECS = 300;

/** HKDF salt for wrap-key derivation (constant across all contexts). */
export const HKDF_WRAP_SALT = 'RPE2E01-WRAP';

/** HKDF info string for the KEYREQ/KEYRSP wrap-key on a given channel. */
export const wrapInfo = (channel: string): string => `RPE2E01-WRAP:${channel}`;

/** HKDF info string for the REKEY distribution wrap-key on a given channel. */
export const rekeyInfo = (channel: string): string => `RPE2E01-REKEY:${channel}`;

/** Fingerprint domain-separation prefix (hashed ahead of the public key). */
export const FP_PREFIX = 'RPE2E01-FP:';
