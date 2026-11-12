/**
 * End-to-end check of the real panel against the real worker and the live speech service.
 *
 * Orca's `plugin shot --act` refuses html panels, so this serves the panel to a headless Chromium
 * with a stand-in `window.orca` whose `plugin.request` calls the worker's own handlers, then drives
 * it over the DevTools protocol. Needs network and a Chromium browser:
 *
 *   CHROME="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" npm run e2e
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import assert from "node:assert/strict";
import { listVoices, net } from "../src/tts.ts";
import { speak } from "../src/worker.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TYPES: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".ts": "text/javascript", ".js": "text/javascript" };

const STUB = `window.orca = Object.freeze({
  locale: "en-US",
  api: { major: 1, minor: 9 },
  on: () => ({ dispose() {} }),
  plugin: {
    async request(name, input, options) {
      const response = await fetch("/__request/" + name, { method: "POST", body: JSON.stringify(input ?? null) });
      const body = await response.json();
      if (!response.ok) throw Object.assign(new Error(body.message), { code: body.code });
      return body.output;
    },
  },
});`;

let speakCalls = 0;
// Count requests in flight at the speech service itself: one per socket turn.
let turns = 0;
let maxTurns = 0;
const RealWebSocket = net.WebSocket;
net.WebSocket = class extends (RealWebSocket as unknown as typeof WebSocket) {
  constructor(url: string, init: object) {
    super(url, init as string[]);
    this.addEventListener("message", ({ data }) => {
      if (typeof data === "string" && data.includes("Path:turn.end")) turns--;
    });
    this.addEventListener("close", () => (turns = 0));
  }
  send(data: string) {
    if (data.includes("Path:ssml")) maxTurns = Math.max(maxTurns, ++turns);
    super.send(data);
  }
} as unknown as typeof net.WebSocket;

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url!, "http://x");
    if (url.pathname.startsWith("/__request/")) {
      let body = "";
      for await (const chunk of req) body += chunk;
      const name = url.pathname.slice("/__request/".length);
      try {
        if (name === "speak") speakCalls++;
        const output = name === "speak" ? await speak(JSON.parse(body)) : name === "voices" ? await listVoices() : undefined;
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ output }));
      } catch (error) {
        const { code = "action_failed", message } = error as { code?: string; message: string };
        res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ code, message }));
      }
      return;
    }
    if (url.pathname === "/__orca.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(STUB);
    const path = normalize(join(ROOT, url.pathname));
    if (!path.startsWith(ROOT)) return res.writeHead(403).end();
    let data = await readFile(path, "utf8");
    if (path.endsWith(".ts")) data = stripTypeScriptTypes(data);
    if (path.endsWith("index.html")) data = data.replace("<script type=\"module\"", '<script src="/__orca.js"></script><script type="module"');
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" }).end(data);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;

const browser = spawn(CHROME, [
  "--headless=new",
  "--remote-debugging-port=0",
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "read-aloud-e2e-"))}`,
  "--autoplay-policy=no-user-gesture-required",
  "--no-first-run",
  "--mute-audio",
  `http://127.0.0.1:${port}/panel/index.html`,
]);
const devtools = await new Promise<string>((resolve, reject) => {
  browser.stderr.on("data", (chunk) => {
    const match = /DevTools listening on (ws:\S+)/.exec(String(chunk));
    if (match) resolve(match[1]);
  });
  browser.on("exit", () => reject(new Error("browser exited")));
});

const targets = await (await fetch(devtools.replace("ws://", "http://").replace(/\/devtools\/browser\/.*/, "/json"))).json();
const page = targets.find((t: { type: string; url: string }) => t.type === "page" && t.url.includes("/panel/"));
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve) => (socket.onopen = resolve));
let nextId = 0;
const pending = new Map<number, (value: { result?: { result?: { value?: unknown } }; error?: unknown }) => void>();
const logs: string[] = [];
socket.onmessage = ({ data }) => {
  const message = JSON.parse(String(data));
  if (message.id !== undefined) pending.get(message.id)?.(message);
  if (message.method === "Runtime.exceptionThrown") logs.push(JSON.stringify(message.params.exceptionDetails));
  if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") logs.push(JSON.stringify(message.params.args));
};
const send = (method: string, params = {}) =>
  new Promise<{ result?: { result?: { value?: unknown } }; error?: unknown }>((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async <T = unknown>(expression: string): Promise<T> => {
  const reply = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (reply.error) throw new Error(JSON.stringify(reply.error));
  return reply.result?.result?.value as T;
};
const waitFor = async (expression: string, what: string, ms = 30_000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${what}; status: ${await evaluate("document.getElementById('status').textContent")}`);
};
const status = () => evaluate<string>("document.getElementById('status').textContent");
const click = (id: string) => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
const key = (k: string) => evaluate(`document.body.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, bubbles: true }))`);

const step = (name: string) => console.log(`✔ ${name}`);

try {
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.bringToFront");
  await send("Page.reload");
  await waitFor("document.readyState === 'complete' && !!window.orca", "page load");

  await waitFor("document.querySelectorAll('#voice option').length > 100", "voice list");
  assert.equal(await evaluate("document.getElementById('voice').value"), "en-US-AvaMultilingualNeural");
  step("voices load and the default voice is selected");

  const markdown = [
    "# Plan",
    "",
    "The **first** step is short. Then `alien.py` runs the [sampler](https://x.y).",
    "",
    "```py",
    "print('not read')",
    "```",
    "",
    "- Item one",
    "- Item two",
    "",
    "That is all.",
  ].join("\n");
  await evaluate(`(() => { const t = document.getElementById("input"); t.value = ${JSON.stringify(markdown)}; t.dispatchEvent(new Event("input")); })()`);
  await click("toggle");
  await waitFor("/^Sentence 1 of/.test(document.getElementById('status').textContent)", "first sentence to play");
  const spans = await evaluate<string[]>("[...document.querySelectorAll('#reader span')].map((s) => s.textContent)");
  assert.deepEqual(spans, ["Plan", "The first step is short.", "Then alien.py runs the sampler.", "(code block)", "Item one", "Item two", "That is all."]);
  assert.equal(await evaluate("document.querySelector('#reader span.current').textContent"), "Plan");
  step("Markdown is stripped, split into sentences, and reading starts at the first");

  await waitFor("/^Sentence 2 of/.test(document.getElementById('status').textContent)", "advance to sentence 2");
  await waitFor("[...CSS.highlights.get('read-aloud-word')].some((r) => r.toString() === 'step' || r.toString() === 'short')", "word highlight inside sentence 2", 5000);
  step("advances on its own and highlights the spoken word");

  await click("toggle");
  assert.equal(await status(), "Paused");
  assert.equal(await evaluate("document.body.classList.contains('playing')"), false);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(await status(), "Paused", "stays paused");
  await key(" ");
  await waitFor("/^Sentence 2 of/.test(document.getElementById('status').textContent)", "resume with Space");
  step("pause and resume (button and Space)");

  await key("ArrowRight");
  await waitFor("/^Sentence 3 of/.test(document.getElementById('status').textContent)", "next sentence");
  await click("prev");
  await waitFor("/^Sentence 2 of/.test(document.getElementById('status').textContent)", "previous sentence");
  step("next and previous sentence");

  await evaluate("document.querySelectorAll('#reader span')[5].click()");
  await waitFor("/^Sentence 6 of/.test(document.getElementById('status').textContent)", "click to read");
  step("clicking a sentence reads from there");

  await evaluate(`(() => { const r = document.getElementById("rate"); r.value = "50"; r.dispatchEvent(new Event("input")); r.dispatchEvent(new Event("change")); })()`);
  assert.equal(await evaluate("document.getElementById('rate-out').textContent"), "1.5×");
  await waitFor("/^Sentence [67] of/.test(document.getElementById('status').textContent)", "keep reading after a speed change");
  assert.equal(JSON.parse(await evaluate<string>("localStorage.getItem('settings')")).rate, 50);
  step("speed change applies at once and persists");

  await waitFor("document.getElementById('status').textContent === 'Finished'", "end of text");
  assert.equal(await evaluate("document.getElementById('stop').disabled"), true);
  step("finishes at the end");

  await click("toggle");
  await waitFor("/^Sentence 1 of/.test(document.getElementById('status').textContent)", "read again");
  await key("Escape");
  assert.equal(await status(), "Ready");
  assert.equal(await evaluate("document.querySelectorAll('#reader span.current').length"), 0);
  step("stop with Esc");

  await click("edit");
  assert.equal(await evaluate("document.getElementById('input').hidden"), false);
  assert.equal(await evaluate("document.getElementById('input').value"), markdown);
  await evaluate(`(() => { const t = document.getElementById("input"); t.value = ""; })()`);
  await click("toggle");
  assert.match(await status(), /Nothing to read/);
  step("edit returns the original text; empty text is refused");

  // The paste event fires before the text lands, as in a real paste.
  await evaluate(`(() => { const t = document.getElementById("input"); t.value = ""; t.dispatchEvent(new ClipboardEvent("paste", { bubbles: true })); t.value = "Pasted text is read."; })()`);
  await waitFor("/^Sentence 1 of 1/.test(document.getElementById('status').textContent)", "auto-read on paste");
  await key("Escape");
  step("pasting into the empty box starts reading");

  assert.equal(maxTurns, 1, "requests to the speech service go one at a time");
  step(`speech requests one at a time (${speakCalls} sentences synthesized)`);
  assert.deepEqual(logs, []);
  step("no errors in the console");
} finally {
  socket.close();
  browser.kill();
  server.close();
  (await import("../src/tts.ts")).close();
}
