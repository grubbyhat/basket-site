// Browser WebSocket: one snapshot on connect, then per-coin updates and the
// SOL price as they change.
import { WebSocketServer } from 'ws';

export function attachLive({ server, watcher, price, coinsView, path = '/ws', log = console }) {
  const wss = new WebSocketServer({ server, path });
  const send = (socket, message) => { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message)); };
  const broadcast = message => { const text = JSON.stringify(message); for (const socket of wss.clients) if (socket.readyState === socket.OPEN) socket.send(text); };
  wss.on('connection', socket => {
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });
    socket.on('error', () => {});
    send(socket, { type: 'snapshot', sol: price.get(), coins: coinsView() });
  });
  const pending = new Map();
  const offWatcher = watcher.on(event => {
    // Coalesce bursts per coin so a hot curve does not flood clients.
    if (pending.has(event.mint)) return;
    pending.set(event.mint, setTimeout(() => { pending.delete(event.mint); broadcast({ type: 'coin', coin: coinsView(event.mint) }); }, 250));
  });
  const offPrice = price.on(sol => broadcast({ type: 'sol', sol }));
  const heartbeat = setInterval(() => { for (const socket of wss.clients) { if (!socket.isAlive) { socket.terminate(); continue; } socket.isAlive = false; socket.ping(); } }, 30_000);
  heartbeat.unref?.();
  return {
    clients: () => wss.clients.size,
    close() { offWatcher(); offPrice(); clearInterval(heartbeat); pending.forEach(clearTimeout); wss.close(); },
  };
}
