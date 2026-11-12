import { test } from "node:test";
import assert from "node:assert/strict";
import { net } from "../src/tts.ts";
import { speak } from "../src/worker.ts";

const valid = { text: "Hi.", voice: "en-US-AvaMultilingualNeural", rate: "+0%", pitch: "+0Hz", volume: "+0%" };

test("speak refuses malformed input before touching the network", async () => {
  net.WebSocket = class {
    constructor() {
      throw new Error("network used");
    }
  } as unknown as typeof net.WebSocket;
  for (const input of [undefined, {}, { ...valid, text: "   " }, { ...valid, text: "x".repeat(2001) }, { ...valid, rate: 5 }]) {
    await assert.rejects(speak(input), (error: { code?: string }) => error.code === "invalid_params");
  }
  // A bad voice is not retried: it fails at once instead of after the backoff.
  const started = Date.now();
  await assert.rejects(speak({ ...valid, voice: "x' y='" }), /Not a voice/);
  assert.ok(Date.now() - started < 400);
});

test("speak returns base64 audio", async () => {
  net.WebSocket = class {
    readyState = 0;
    binaryType = "";
    onopen?: () => void;
    onmessage?: (event: { data: unknown }) => void;
    constructor() {
      queueMicrotask(() => ((this.readyState = 1), this.onopen?.()));
    }
    send(data: string) {
      if (!data.includes("Path:ssml")) return;
      queueMicrotask(() => {
        this.onmessage?.({ data: new Uint8Array([0, 0, 104, 105]).buffer });
        this.onmessage?.({ data: "Path:turn.end\r\n\r\n" });
      });
    }
    close() {}
  } as unknown as typeof net.WebSocket;
  const { audio, boundaries } = await speak(valid);
  assert.equal(Buffer.from(audio, "base64").toString(), "hi");
  assert.deepEqual(boundaries, []);
});

test("a request cancelled while queued never reaches the service", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(speak(valid, controller.signal), (error: { code?: string }) => error.code === "cancelled");
});
