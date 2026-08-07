# Client migration: 1.1.x → 2.0

Lurker 2.0 removes protocol surface for the first time. If you maintain a client
— third-party, or your own fork — this page is the whole list, in the order
you'll hit it.

Everything here is detailed in [Client Protocol & API](/CLIENT_PROTOCOL); this
page is the diff, not a replacement for it.

## TL;DR

- The **Friends/Contacts system is gone**, verbs and frames both. It's replaced
  by buffer favorites, which are server-side and cross-device.
- **`bufferId` is the new identity.** Additive — every buffer verb still accepts
  `networkId` + `target` — but names are no longer stable, so keying on them is
  now a bug you can observe.
- Operators: the database migrates **16 → 19** and does not migrate back, and
  the runtime floor is **Node 24**.

---

## Breaking: the contacts system is gone

### Verbs removed

| Removed          | Replacement         |
| ---------------- | ------------------- |
| `set-contact`    | `favorite-buffer`   |
| `delete-contact` | `unfavorite-buffer` |

### Frames removed

| Removed                             | Replacement         |
| ----------------------------------- | ------------------- |
| `contacts-snapshot` (connect burst) | `favorites-changed` |
| `contact-updated`                   | `favorites-changed` |
| `contact-deleted`                   | `favorites-changed` |

**The failure mode to check for first:** a client that waits for
`contacts-snapshot` during the connect burst before it considers itself hydrated
will now wait forever. That frame is never sent. There is no error and no
timeout — the burst simply completes without it.

### What replaces them

One flag, `favorite`, on the buffer itself:

```jsonc
// client → server
{ "type": "favorite-buffer",   "networkId": 1, "target": "#lurker" }
{ "type": "unfavorite-buffer", "bufferId": 42 }
{ "type": "reorder-favorites", "bufferIds": [42, 17, 8] }
```

```jsonc
// server → client, in the connect burst and after every change
{
  "kind": "favorites-changed",
  "favorites": [{ "networkId": 1, "target": "#lurker", "bufferId": 42 }],
}
```

Five things that catch people:

1. **`favorites-changed` carries the FULL global order.** Replace your list
   wholesale; don't merge or patch it. Every later favorite, unfavorite and
   reorder sends the same frame with the same meaning.
2. **An older server never sends it.** No frame ⇒ treat favorites as empty
   rather than as "not loaded yet".
3. **Favorite ⇔ pin is exclusive.** Favoriting a pinned buffer drops the pin,
   and you'll get a `pins-changed` alongside the `favorites-changed`. A buffer
   has one placement: a network group, a pin, or a favorite.
4. **`reorder-favorites` is id-form only.** Favorites span networks, so bare
   target strings can't address them — and you already hold the ids from
   `favorites-changed`. It may be a subset: unmentioned favorites keep their
   relative order after the ones you supply, so a kind-filtered section can
   reorder independently.
5. **One flag, two labels.** Channels surface as "Favorites", DMs as "Friends" —
   that's presentation, not two different states. Split on the channel prefix
   (below), not on your own notion of buffer kind.

Server and system pseudo-buffers (`:`-prefixed targets) and CLOSED buffers are
refused.

### You don't migrate the user's data

The v19 migration converts existing contacts into favorites server-side. Clients
get the converted list in the connect burst like any other. Don't write a
client-side migration; you'd be racing the server for the same rows.

### `:friends:` was never a wire concept

If you implemented a `:friends:` virtual buffer, it was a client-side view — the
server has never known about it. Drop it.

While you're there: **split channels from DMs on the IRC channel prefix**, which
is `#`, `&`, `+` or `!` — matching the server's `kindForTarget`. Testing only for
`#` misfiles `&`/`+`/`!` channels as DMs, which then get presence dots, whois
menu items and nick colouring that make no sense. Lurker's own web client had
this bug in about thirty places; it is easy to inherit.

---

## Breaking, in effect: names are no longer identity

Nothing was removed here, but an assumption was.

A buffer's `target` can now change under you while the buffer stays the same
buffer: a DM follows its peer through a `/nick`, and a `CASEMAPPING` refold can
merge two case-twin buffers into one. If you key per-buffer state (scroll
position, drafts, read marks, unread counts) by name, that state detaches when
either happens.

Use **`bufferId`**, a server-assigned integer that survives both:

```jsonc
{
  "kind": "buffer-renamed",
  "networkId": 1,
  "from": "bob",
  "to": "bob_",
  "bufferId": 42,
  "merged": false,
  "mergedFromBufferId": null,
}
```

- Every `backlog` frame carries `bufferId`, so the connect burst doubles as your
  name → id directory.
- `merged: true` means two buffers became one; `mergedFromBufferId` is the id
  that no longer exists. Fold your state for it into the survivor.
- Treat the name as a **resolvable attribute**, not a key.

**`bufferId` is `null` in exactly one degenerate case** — a live-joined channel
whose registry row was lost mid-session — and **absent** on the one
`buffer-opened` ack for a channel still being JOINed, because no row exists until
the echo. Don't assume non-null; do assume that anything with an id keeps it.

---

## Additive: address buffers by id

Optional, and worth adopting alongside the above. Where present and valid,
`bufferId` **wins** over `networkId`/`target`, which may then be omitted. An id
that doesn't resolve to one of your buffers drops the verb — the same outcome as
an unknown name.

Accepting the id form in place of `networkId` + `target`: `mark-read`,
`clear-buffer` / `unclear-buffer`, `pin-buffer` / `unpin-buffer`,
`favorite-buffer` / `unfavorite-buffer`, `set-nicklist-collapsed`,
`set-channel-notify-always`, `draft-set` / `draft-clear`, `input-history-add`.

Two list verbs don't follow that rule, and both will silently do nothing if you
assume they do:

- **`reorder-pins`** takes `bufferIds:[…]` instead of `targets:[…]`, but still
  **requires `networkId`** — pins are ordered within one network, so the id form
  replaces the targets, not the network. Omit it and the verb is dropped.
- **`reorder-favorites`** is the opposite: id-form **only**, and takes no
  `networkId` at all, because favorites span networks.

Verbs addressing IRC **entities** rather than buffers stay name-only — `send`,
`action`, `notice`, `join`, `part`, `typing`, `e2e`, `ctcp` — because the name is
what goes on the IRC wire. `open-buffer`'s id form addresses an existing row
only; minting a new DM or JOINing a channel is inherently name-first.

---

## Known gap: the MCP / HTTP API lost contacts

`server/services/verbs/` is a shared registry feeding both the WebSocket
delegators and the MCP server, and the contact verbs lived there. They were
removed with the rest of the system, but **the favorites replacements are
WebSocket-only** — there is no `favorite-buffer` equivalent on the MCP surface
today.

If you drive Lurker through [MCP or the HTTP API](/MCP), contacts are gone with
no replacement in 2.0. Nothing in those docs is stale; the capability simply
isn't there yet.

---

## For operators

- **Schema 16 → 19, one-way.** Three migrations run on first boot: v17
  re-keys `messages` onto `buffers.id` with a resumable backfill, v18 rebuilds
  the view-state satellites onto `buffer_id`, v19 converts contacts into
  favorites. **There is no downgrade path** — take a backup before upgrading if
  you might want to roll back to 1.1.x.
- **Node 24 LTS is the floor.** The Docker image already carries it; if you run
  from source, upgrade Node before upgrading Lurker.
- **First-party clients need to move together.** A pre-2.0 build of the iOS app
  pointed at a 2.0 server has a Friends section talking to frames that no longer
  exist. Update both.
