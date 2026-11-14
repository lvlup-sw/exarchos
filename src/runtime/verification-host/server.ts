/** The independent host accepts one bounded authenticated frame per private local connection. */
import { createServer, type Socket } from 'node:net';
import { chmod, lstat } from 'node:fs/promises';
import { verificationFrameReader, encodeVerificationFrame } from '../../contract/verification/harness-verification.js';
import { loadHostProvisioning } from './provisioning.js';
import { createVerificationDispositions } from './dispositions.js';
import { confirmConfinement } from './processes.js';

/** Refuse existing listener paths and expose only a private operator-owned socket. */
export async function startVerificationHost(path: string) {
  const config = await loadHostProvisioning(path);
  try { await lstat(config.policy.socketPath); throw new Error('Socket path already exists'); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  await confirmConfinement(config.policy.bwrapPath);
  const service = createVerificationDispositions(config);
  const sockets = new Set<Socket>();
  let closing = false;
  const server = createServer({ allowHalfOpen: true }, socket => {
    if (closing) { socket.destroy(); return; }
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    const reader = verificationFrameReader();
    const admissionDeadline = setTimeout(() => socket.destroy(), 10000);
    let responseDeadline: ReturnType<typeof setTimeout> | undefined;
    socket.once('close', () => {
      clearTimeout(admissionDeadline);
      clearTimeout(responseDeadline);
    });
    socket.on('error', () => socket.destroy());
    let admitted = false;
    socket.on('data', bytes => {
      if (admitted) { socket.destroy(); return; }
      try { reader.push(bytes); } catch { socket.destroy(); return; }
      if (!reader.complete()) return;
      admitted = true;
      clearTimeout(admissionDeadline);
      void (async () => {
        try {
          const frame = encodeVerificationFrame(await service.handle(reader.finish()));
          if (socket.destroyed) return;
          responseDeadline = setTimeout(() => socket.destroy(), 1000);
          socket.end(frame);
        } catch { socket.destroy(); }
      })();
    });
    socket.once('end', () => { if (!admitted) socket.destroy(); });
  });
  server.maxConnections = 16;
  const mask = process.umask(0o077);
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.policy.socketPath, resolve); });
    await chmod(config.policy.socketPath, 0o600);
  } catch (error) { server.close(); await service.close(); throw error; }
  finally { process.umask(mask); }
  const bound = await lstat(config.policy.socketPath);
  return {
    async close() {
      closing = true;
      const current = await lstat(config.policy.socketPath);
      if (current.ino !== bound.ino || current.dev !== bound.dev) { server.unref(); throw new Error('Socket identity changed'); }
      const stopped = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      for (const socket of sockets) socket.destroy();
      await service.close();
      await stopped;
    },
  };
}
