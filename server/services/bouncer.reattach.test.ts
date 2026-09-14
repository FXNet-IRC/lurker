// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// An engine re-attach, as a client attached through the bouncer sees it. When
// the link between the app and the engine drops but the IRC socket survives, the
// app re-attaches and the engine replays the session into it: the registration
// burst, LUSERS, MOTD and a JOIN for every channel. A client that stayed
// attached has all of that already, and irssi rebuilds any channel it gets a
// second self-JOIN for. What the network said during the gap is news, though.

// MUST be first: redirects DATABASE_PATH before anything opens the db.
import '../test-utils/isolateDb.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createUser, setPasswordHash } from '../db/users.js';
import { createNetwork } from '../db/networks.js';
import type { Network } from '../db/networks.js';
import ircManager from './ircManager.js';
import { hashPassword } from './password.js';
import { EngineLink, engineConnectionId } from './engineLink.js';
import { rawClient } from '../test-utils/fakeIrcd.js';
import type { FakeIrcd } from '../test-utils/fakeIrcd.js';
import { startEngineHarness } from '../test-utils/engineHarness.js';
import type { EngineHarness } from '../test-utils/engineHarness.js';

const NICK = 'stayer';
const PASSWORD = 'hunter2hunter2';
const NUL = String.fromCharCode(0);

let harness: EngineHarness;
let ircd: FakeIrcd;
let network: Network;
let userId: number;
let username: string;
let bouncerHarness: typeof import('../test-utils/bouncerHarness.js');
let bouncer: typeof import('./bouncer.js');
let listener: import('../test-utils/bouncerHarness.js').Harness;
const sockets: Array<{ destroy(): void }> = [];

beforeAll(async () => {
  harness = await startEngineHarness({
    secret: 'bouncer-reattach-secret',
    // The link comes back after 1.5 s rather than 0.1 s, so what the network
    // says in between is the engine's backlog, not live traffic.
    env: { LURKER_ENGINE_RETRY_BASE_MS: '1500' },
  });
  ircd = harness.ircd;
  process.env.LURKER_BOUNCER_ENABLED = 'true';
  bouncerHarness = await import('../test-utils/bouncerHarness.js');
  bouncer = await import('./bouncer.js');
  listener = await bouncerHarness.startHarness();
  const user = createUser('bouncer-reattach');
  userId = user.id;
  username = user.username;
  setPasswordHash(user.id, hashPassword(PASSWORD));
  network = createNetwork(user.id, {
    name: 'reattach',
    host: '127.0.0.1',
    port: ircd.port,
    tls: 0,
    nick: NICK,
    autoconnect: 0,
  })!;
});

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  listener.stop();
  await harness.stop();
  delete process.env.LURKER_BOUNCER_ENABLED;
});

describe('an engine re-attach', () => {
  it('sends an attached client what it missed, and nothing of the replay', async () => {
    const until = harness.until;
    const commandOf = bouncerHarness.commandOf;
    const bob = await rawClient(ircd.port, 'bob');
    sockets.push(bob.socket);
    bob.send('JOIN #one');
    await bob.waitFor(/ 366 bob #one /);

    const conn = ircManager.startNetwork(userId, network.id)!;
    harness.tap(conn, NICK);
    await until(() => conn.state === 'connected', 5000, 'connected');
    conn.join('#one');
    conn.join('#two');
    await until(
      () => !conn.membersPending('#one') && !conn.membersPending('#two'),
      5000,
      'names heard',
    );

    const client = await listener.connect();
    client.send('CAP LS 302');
    await client.waitFor((l) => l.includes('CAP') && l.includes('LS'));
    client.send('NICK client');
    client.send('USER client 0 * :client');
    client.send('CAP REQ :sasl');
    await client.waitFor((l) => l.includes('ACK'));
    client.send('AUTHENTICATE PLAIN');
    await client.waitFor((l) => l === 'AUTHENTICATE +');
    client.send(
      `AUTHENTICATE ${Buffer.from(['', username, PASSWORD].join(NUL)).toString('base64')}`,
    );
    await client.waitForCommand('903');
    client.send('CAP END');
    await client.waitForCommand('422');

    // Everything the network sent before now has reached the client.
    let sentinels = 0;
    const sentinel = async () => {
      const text = `sentinel${++sentinels}`;
      ircd.sendRaw(NICK, `:fake.test NOTICE ${NICK} :${text}`);
      await client.waitFor((l) => l.endsWith(`:${text}`), 5000);
    };
    await sentinel();
    const mark = client.lines.length;
    const registrations = ircd.registrations.length;

    EngineLink.shared().simulateLoss();
    await until(() => conn.state !== 'connected', 5000, 'the link loss');
    // Said while the app is away, so it reaches the client from the backlog.
    const engineId = engineConnectionId(userId, network.id);
    const buffered = () => harness.engine.info(engineId)?.bufferedLines ?? 0;
    const bufferedBefore = buffered();
    ircd.say('bob', '#one', 'while away');
    await until(() => buffered() > bufferedBefore, 5000, 'the engine buffered the gap');
    await until(() => conn.state === 'connected' && !conn.catchingUp, 10000, 'live again');
    await sentinel();

    const after = client.lines.slice(mark);
    // A re-attach, not a reconnect, and the client stayed.
    expect(ircd.registrations).toHaveLength(registrations);
    expect(bouncer.attachedSessionCount(userId, network.id)).toBe(1);
    // What the network said in the gap arrives, once.
    expect(after.filter((l) => l.endsWith('PRIVMSG #one :while away'))).toHaveLength(1);
    // Nothing the replay carried does.
    const replayed = ['251', '375', '372', '376', 'JOIN', 'NICK'];
    expect(after.filter((l) => replayed.includes(commandOf(l)))).toEqual([]);
  }, 40000);
});
