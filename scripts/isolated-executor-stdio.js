import { createConnection } from 'node:net';
import path from 'node:path';

const [filename] = process.argv.slice(2);
if (process.argv.length !== 3 || !path.isAbsolute(filename || '') || filename.includes('\0')) {
  console.error('Expected one absolute executor socket path');
  process.exit(2);
}

const socket = createConnection({ path: filename, allowHalfOpen: true });
const connectDeadline = setTimeout(() => fail(), 5000);

function fail() {
  if (!process.exitCode) console.error('Executor socket connection failed');
  process.exitCode = 1;
  socket.destroy();
}

socket.once('connect', () => {
  clearTimeout(connectDeadline);
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
});
socket.on('error', fail);
process.stdin.on('error', fail);
process.stdout.on('error', fail);

// The host controls the executor lifetime. Once it closes its write side,
// there are no further responses to relay to the caller.
socket.once('end', () => socket.end());
socket.once('close', () => {
  clearTimeout(connectDeadline);
  process.stdin.unpipe(socket);
  process.stdin.pause();
});
