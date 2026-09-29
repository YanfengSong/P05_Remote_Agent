import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { TerminalHost, type TerminalView } from '../v3/terminal/host.js';
import { createRpcClient, startRpcServer } from '../v3/transport/rpc.js';

const config = (root: string) => ({ stateDir: join(root, 'state'), workspaceRoot: join(root, 'workspace'), slot: 'A', principal: 'alice', securityMode: 'trusted-host' as const, authorizationRevision: '1', maxOutputBytes: 32768 });
const openRequest = (args: string[], intentId: string) => ({ executable: process.execPath, args, cols: 80, rows: 24, intentId, authorizationRef: 'approved-open' });
async function waitFor(check: () => boolean, label: string): Promise<void> { for (let n = 0; n < 500; n++) { if (check()) return; await sleep(10); } throw new Error('Timed out: ' + label); }
function output(host: TerminalHost, id: string): string { return Buffer.from(host.output({ id }).dataBase64, 'base64').toString('utf8'); }

if (process.env.P05_TERMINAL_CRASH_ROOT) {
  const root = process.env.P05_TERMINAL_CRASH_ROOT;
  const host = new TerminalHost(config(root));
  const session = host.open(openRequest([join(root, 'workspace', 'crash-child.cjs')], 'crash-key'));
  await waitFor(() => output(host, session.id).includes('CRASH_READY'), 'crash child ready');
  process.send?.({ id: session.id });
} else {
  const root = await mkdtemp(join(tmpdir(), 'p05-terminal-'));
  await mkdir(join(root, 'state')); await mkdir(join(root, 'workspace'));
  let host = new TerminalHost(config(root));
  try {
    assert.throws(() => new TerminalHost(config(root)), /HOST_ALREADY_RUNNING/);
    assert.deepEqual(await host.handle('terminal_open', {}, 'operator'), { error: { code: 'FORBIDDEN' } });
    assert.throws(() => host.open({ ...openRequest([], 'invalid'), cwd: root }), /Unrecognized/);
    process.env.P05_FAKE_CORE_TOKEN = 'must-not-reach-terminal';
    const script = "console.log('READY:'+JSON.stringify({stdin:process.stdin.isTTY,stdout:process.stdout.isTTY,token:process.env.P05_FAKE_CORE_TOKEN||null,options:process.env.NODE_OPTIONS||null}));console.log('UTF8:é🙂');process.stdin.setRawMode(true);process.stdin.on('data',d=>{if(d.toString()==='q'){console.log('BYE');process.exit(0)}console.log('INPUT:'+d.toString()+':'+process.stdout.getWindowSize().join(':'));});";
    const request = openRequest(['-e', script], 'pty-one');
    const session = host.open(request);
    delete process.env.P05_FAKE_CORE_TOKEN;
    assert.equal(host.open(request).id, session.id);
    assert.throws(() => host.open({ ...request, rows: 30 }), /INTENT_CONFLICT/);
    await waitFor(() => output(host, session.id).includes('READY:'), 'TTY ready');
    assert.match(output(host, session.id), /"stdin":true,"stdout":true,"token":null,"options":null/);
    host.resize({ id: session.id, cols: 100, rows: 35, intentId: 'resize', authorizationRef: 'approved-resize' });
    await sleep(200);
    const input = { id: session.id, data: 'x', intentId: 'input', authorizationRef: 'approved-input' };
    host.input(input); host.input(input);
    assert.throws(() => host.input({ ...input, data: 'y' }), /INTENT_CONFLICT/);
    await waitFor(() => output(host, session.id).includes('INPUT:x:100:35'), 'input and resize');
    assert.equal(output(host, session.id).split('INPUT:x:100:35').length, 2);
    assert.equal((host.intentStatus({ id: session.id, intentId: 'input' }) as { state: string }).state, 'ACCEPTED');
    const page1 = host.output({ id: session.id, limit: 7 }), page2 = host.output({ id: session.id, offset: page1.nextOffset, limit: 9 });
    assert.equal(page2.nextOffset, 16);
    assert.equal(Buffer.concat([Buffer.from(page1.dataBase64, 'base64'), Buffer.from(page2.dataBase64, 'base64')]).toString('hex'), Buffer.from(host.output({ id: session.id, limit: 16 }).dataBase64, 'base64').toString('hex'));
    assert.throws(() => host.output({ id: session.id, offset: 999999 }), /INVALID_CURSOR/);
    const all = host.output({ id: session.id }), pieces: Buffer[] = [];
    for (let offset = 0; offset < all.availableBytes;) { const page = host.output({ id: session.id, offset, limit: Math.min(3, all.availableBytes - offset) }); pieces.push(Buffer.from(page.dataBase64, 'base64')); offset = page.nextOffset; }
    assert.equal(Buffer.concat(pieces).toString('utf8'), Buffer.from(all.dataBase64, 'base64').toString('utf8'));
    assert.match(Buffer.concat(pieces).toString('utf8'), /UTF8:é🙂/);
    const server = await startRpcServer({ clientToken: 'c'.repeat(40), operatorToken: 'o'.repeat(40), handle: (m, p, r) => host.handle(m, p, r) });
    const client = createRpcClient({ url: server.url, token: 'c'.repeat(40) });
    assert.equal((await client.call('terminal_attach', { id: session.id }) as TerminalView).id, session.id);
    await server.close();
    assert.equal(host.status({ id: session.id }).state, 'RUNNING'); // transport disconnect is detach
    host.input({ ...input, intentId: 'quit', data: 'q' });
    await waitFor(() => host.status({ id: session.id }).state === 'EXITED', 'natural terminal exit');
    assert.equal(host.status({ id: session.id }).receipt!.exitCode, 0);
    assert.equal(host.status({ id: session.id }).receipt!.treeTermination, 'unconfirmed');
    await waitFor(() => host.health().activeSessions === 0, 'runner releases native workers');

    const flooding = host.open(openRequest(['-e', "console.log('FLOOD_READY');setInterval(()=>console.log('z'.repeat(2000)),1)"], 'flood'));
    await waitFor(() => host.status({ id: flooding.id }).truncated, 'bounded output');
    assert.ok(host.status({ id: flooding.id }).storedBytes <= 32768);
    host.cancel({ id: flooding.id, intentId: 'cancel-flood', authorizationRef: 'approved-cancel' });
    await waitFor(() => host.status({ id: flooding.id }).state === 'EXITED', 'cancel receives exit');
    assert.equal(host.status({ id: flooding.id }).cancelRequested, true);
    assert.equal(host.status({ id: flooding.id }).receipt!.treeTermination, 'unconfirmed');
    await host.close();
    host = new TerminalHost(config(root));
    assert.equal(host.status({ id: session.id }).state, 'EXITED');
    assert.equal(host.open(request).id, session.id);
    await host.close();
    assert.throws(() => new TerminalHost({ ...config(root), principal: 'bob' }), /HOST_BINDING_MISMATCH/);

    await mkdir(join(root, 'expiry-state'));
    const expiring = new TerminalHost({ ...config(root), stateDir: join(root, 'expiry-state'), maxLifetimeMs: 500 });
    try {
      const expires = expiring.open(openRequest(['-e', "console.log('READY');setInterval(()=>{},1000)"], 'expires'));
      await waitFor(() => ['EXITED', 'UNKNOWN'].includes(expiring.status({ id: expires.id }).state), 'session lifetime');
      assert.equal(expiring.status({ id: expires.id }).cancelRequested, true);
      assert.equal(expiring.status({ id: expires.id }).receipt!.treeTermination, 'unconfirmed');
    } finally { await expiring.close(); }

    await writeFile(join(root, 'workspace', 'crash-child.cjs'), "require('node:fs').appendFileSync('effects.txt','once\\n');console.log('CRASH_READY');setInterval(()=>{},1000);");
    const child = fork(fileURLToPath(import.meta.url), [], { env: { ...process.env, P05_TERMINAL_CRASH_ROOT: root }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const exit = once(child, 'exit');
    const controller = new AbortController();
    let crashedId = '';
    try { const [message] = await Promise.race([once(child, 'message'), sleep(10000, undefined, { signal: controller.signal }).then(() => { throw new Error('Crash Host timeout'); })]); crashedId = (message as { id: string }).id; }
    finally { controller.abort(); child.kill('SIGKILL'); await exit; }
    host = new TerminalHost(config(root));
    assert.equal(host.status({ id: crashedId }).state, 'UNKNOWN');
    assert.equal(host.open(openRequest([join(root, 'workspace', 'crash-child.cjs')], 'crash-key')).id, crashedId);
    await sleep(1200);
    assert.equal(await readFile(join(root, 'workspace', 'effects.txt'), 'utf8'), 'once\n');
    assert.throws(() => host.input({ id: crashedId, data: 'x', intentId: 'cannot-replay', authorizationRef: 'approved' }), /TERMINAL_NOT_WRITABLE/);
    console.log('v3-terminal: real ConPTY, input dedup, resize, bounded output, detach, cancellation, runner exit, binding and crash UNKNOWN passed');
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
}
