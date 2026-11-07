import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import http from "node:http";

/** Choose a test-owned port without probing any remote target. */
export async function unusedLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

/** Confine this test process's HTTP listeners to loopback; production code is unchanged. */
function confineHttpListeners() {
  const original = http.Server.prototype.listen;
  http.Server.prototype.listen = function (...args) {
    if (typeof args[0] === "number" && typeof args[1] !== "string") {
      args.splice(1, 0, "127.0.0.1");
    } else if (args[0] && typeof args[0] === "object" && "port" in args[0]) {
      args[0] = { ...args[0], host: "127.0.0.1" };
    }
    return original.apply(this, args);
  };
}

/** Retain unique, test-owned temporary fixtures; never clear a shared directory. */
export async function createTestFixture(label) {
  confineHttpListeners();
  const root = mkdtempSync(join(tmpdir(), `pi-websocket-${label}-`));
  const project = join(root, "project");
  const home = join(root, "home");
  mkdirSync(project, { mode: 0o700 });
  mkdirSync(home, { mode: 0o700 });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return {
    root,
    project,
    home,
    config: join(root, "config.json"),
    store: join(root, "files"),
    image: join(project, "publish.png"),
    text: join(project, "publish.txt"),
    outside: join(root, "outside.txt"),
    port: await unusedLoopbackPort(),
  };
}
