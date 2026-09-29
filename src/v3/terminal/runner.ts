import * as pty from 'node-pty';

// Each native PTY lives in a separate process. In particular, node-pty 1.1.0's
// Windows Conout worker must not keep accumulating in a long-lived Core/Host.
let terminal: pty.IPty | undefined;
let finished = false;
let queuedBytes = 0, droppedBytes = 0;
function send(value: unknown): void { if (process.connected) process.send?.(value); }
function end(code: number): void {
  if (finished) return;
  finished = true;
  // Exit explicitly after the final IPC message flushes; native workers may stay referenced.
  if (process.connected) process.send?.({ kind: 'done' }, () => process.exit(code));
  else process.exit(code);
}
process.on('message', (raw: unknown) => {
  const message = raw as { kind: string; executable: string; args: string[]; cwd: string; cols: number; rows: number; data: string; intentId: string };
  try {
    if (message.kind === 'start' && !terminal) {
      terminal = pty.spawn(message.executable, message.args, { cwd: message.cwd, env: process.env, cols: message.cols, rows: message.rows, name: 'xterm-256color', useConpty: true, useConptyDll: true, handleFlowControl: false });
      terminal.onData(data => {
        const bytes = Buffer.byteLength(data);
        if (!process.connected || queuedBytes + bytes > 256 * 1024) { droppedBytes += bytes; return; }
        if (droppedBytes) { send({ kind: 'dropped', bytes: droppedBytes }); droppedBytes = 0; }
        queuedBytes += bytes;
        process.send?.({ kind: 'output', data }, () => { queuedBytes -= bytes; });
      });
      terminal.onExit(({ exitCode, signal }) => { if (droppedBytes) send({ kind: 'dropped', bytes: droppedBytes }); send({ kind: 'exit', exitCode, signal }); end(0); });
      send({ kind: 'started' });
    } else if (message.kind === 'input' && terminal) {
      terminal.write(message.data); send({ kind: 'ack', intentId: message.intentId });
    } else if (message.kind === 'resize' && terminal) {
      terminal.resize(message.cols, message.rows); send({ kind: 'ack', intentId: message.intentId });
    } else if (message.kind === 'cancel' && terminal) {
      terminal.kill(); if (message.intentId) send({ kind: 'ack', intentId: message.intentId });
    } else throw new Error('Invalid runner command');
  } catch { send({ kind: 'uncertain', intentId: message.intentId }); end(1); }
});
process.once('disconnect', () => {
  try { terminal?.kill(); } catch { /* no termination claim without exit evidence */ }
  setTimeout(() => end(1), 1000).unref();
});
