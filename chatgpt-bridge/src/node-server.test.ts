import { describe, expect, it } from "bun:test";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { startServer } from "./node-server.js";

describe("Node bridge server", () => {
  it("serves the existing health route through the Node HTTP runtime", async () => {
    const server = startServer(0, "127.0.0.1");
    await once(server, "listening");

    try {
      const address = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}/health`);

      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      expect(body.status).toBe("ok");
      expect(body.service).toBe("chatgpt-image-bridge");
      expect(typeof body.timestamp).toBe("number");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});
