// A TCP pass-through that tests can close to simulate the storage server going away.
import net from "node:net";

export async function startTcpProxy(targetPort, targetHost = "127.0.0.1") {
  const sockets = new Set();
  const server = net.createServer((client) => {
    const upstream = net.connect(targetPort, targetHost);
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
    }
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}
