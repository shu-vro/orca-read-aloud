import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { close, listVoices, net, ssml, synthesize } from "../src/tts.ts";

const prosody = { voice: "en-US-AvaMultilingualNeural", rate: "+0%", pitch: "+0Hz", volume: "+0%" };

function audioFrame(bytes: number[]): ArrayBuffer {
  const header = new TextEncoder().encode("Path:audio\r\n");
  const frame = new Uint8Array(2 + header.length + bytes.length);
  frame[1] = header.length;
  frame.set(header, 2);
  frame.set(bytes, 2 + header.length);
  return frame.buffer;
}

type Behaviour = "ok" | "silent" | "drop";
let sockets: FakeSocket[] = [];
let behaviour: Behaviour[] = [];

class FakeSocket {
  url: string;
  headers: Record<string, string>;
  readyState = 0;
  binaryType = "blob";
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(url: string, init: { headers: Record<string, string> }) {
    this.url = url;
    this.headers = init.headers;
    sockets.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }
  send(data: string) {
    this.sent.push(data);
    if (!data.includes("Path:ssml")) return;
    const mode = behaviour.shift() ?? "ok";
    queueMicrotask(() => {
      if (mode === "drop") return this.close();
      if (mode === "ok") {
        this.onmessage?.({
          data:
            "Path:audio.metadata\r\n\r\n" +
            JSON.stringify({ Metadata: [{ Type: "WordBoundary", Data: { Offset: 1e6, Duration: 2e6, text: { Text: "a &amp; b" } } }] }),
        });
        this.onmessage?.({ data: audioFrame([1, 2]) });
        this.onmessage?.({ data: audioFrame([3]) });
      }
      this.onmessage?.({ data: "Path:turn.end\r\n\r\n{}" });
    });
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

beforeEach(() => {
  close();
  sockets = [];
  behaviour = [];
  net.WebSocket = FakeSocket as unknown as typeof net.WebSocket;
});

test("synthesize joins audio frames and reports boundaries", async () => {
  const clip = await synthesize("Hi there.", prosody);
  assert.deepEqual([...clip.audio], [1, 2, 3]);
  assert.deepEqual(clip.boundaries, [{ offset: 1e6, duration: 2e6, text: "a & b" }]);
  const [socket] = sockets;
  assert.match(socket.url, /Sec-MS-GEC=[0-9A-F]{16}-[0-9A-F]{64}&Sec-MS-GEC-Version=2-/);
  assert.match(socket.headers["User-Agent"], /Edg\//);
  assert.match(socket.sent[0], /Path:speech\.config/);
  assert.match(socket.sent[1], /<voice name='en-US-AvaMultilingualNeural'>/);
});

test("consecutive requests reuse one socket", async () => {
  await synthesize("One.", prosody);
  await synthesize("Two.", prosody);
  assert.equal(sockets.length, 1);
});

test("a stale parked socket is retried once on a fresh one", async () => {
  await synthesize("One.", prosody);
  behaviour = ["drop", "ok"];
  const clip = await synthesize("Two.", prosody);
  assert.equal(clip.audio.length, 3);
  assert.equal(sockets.length, 2);
});

test("a socket parked too long is not reused", async (t) => {
  await synthesize("One.", prosody);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 16_000 });
  try {
    await synthesize("Two.", prosody);
  } finally {
    t.mock.timers.reset();
  }
  assert.equal(sockets.length, 2);
  assert.equal(sockets[0].readyState, 3, "the old one is closed");
});

test("a turn with no audio is an error", async () => {
  behaviour = ["silent"];
  await assert.rejects(synthesize("Hi.", prosody), /No audio/);
});

test("ssml escapes text and refuses values that would break out of attributes", () => {
  assert.match(ssml(`<b>"Tom" & 'Jerry'</b>`, prosody), /&lt;b&gt;&quot;Tom&quot; &amp; &apos;Jerry&apos;&lt;\/b&gt;/);
  assert.throws(() => ssml("x", { ...prosody, voice: "x' onload='" }), /Not a voice/);
  assert.throws(() => ssml("x", { ...prosody, rate: "+0%'" }), /Not a prosody/);
});

test("listVoices keeps only the fields the panel uses", async () => {
  const realFetch = net.fetch;
  net.fetch = (async (url: string, init: { headers: Record<string, string> }) => {
    assert.match(url, /voices\/list\?trustedclienttoken=/);
    assert.match(init.headers["User-Agent"], /Edg\//);
    return new Response(JSON.stringify([{ ShortName: "en-US-AvaNeural", Locale: "en-US", Gender: "Female", Status: "GA" }]));
  }) as typeof fetch;
  try {
    assert.deepEqual(await listVoices(), [{ ShortName: "en-US-AvaNeural", Locale: "en-US", Gender: "Female" }]);
  } finally {
    net.fetch = realFetch;
  }
});
