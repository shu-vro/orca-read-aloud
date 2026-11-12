/**
 * Text in, one MP3 clip and its word boundaries out, over Edge's Read Aloud WebSocket.
 * Runs in the plugin's Node worker: Orca's panel frames have no network.
 *
 * The handshake costs about twice what synthesizing a sentence does, so a socket is kept and
 * reused: the service accepts one request after another on the same connection.
 */

import { randomUUID } from "node:crypto";
import { secMsGec } from "./gec.ts";

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const BASE = "speech.platform.bing.com/consumer/speech/synthesize/readaloud";
/** The token scheme (`2-` prefix) and the User-Agent's Edge version must agree. */
const GEC_VERSION = "2-143.0.3650.75";
const CHROMIUM = GEC_VERSION.slice(2).split(".")[0];
/** The service answers 403 to anything that is not Edge. */
export const HEADERS = {
  "User-Agent":
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
    `Chrome/${CHROMIUM}.0.0.0 Safari/537.36 Edg/${CHROMIUM}.0.0.0`,
  Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
  Pragma: "no-cache",
  "Cache-Control": "no-cache",
};
const CONNECT_TIMEOUT_MS = 8000;
/** A request that has started but stopped sending for this long is dead. */
const TURN_TIMEOUT_MS = 20000;

const CONFIG =
  "Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n" +
  JSON.stringify({
    context: {
      synthesis: {
        audio: {
          metadataoptions: { sentenceBoundaryEnabled: "false", wordBoundaryEnabled: "true" },
          outputFormat: "audio-24khz-48kbitrate-mono-mp3",
        },
      },
    },
  });

export type Prosody = { voice: string; rate: string; pitch: string; volume: string };
/** Times in 100-nanosecond units, as the service reports them. */
export type Boundary = { offset: number; duration: number; text: string };
export type Clip = { audio: Uint8Array; boundaries: Boundary[] };

const id = () => randomUUID().replaceAll("-", "");
const query = () => `Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=${GEC_VERSION}`;

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&apos;", '"': "&quot;" };
/** Control characters are not legal in XML at all, escaped or not. */
export const escapeXml = (text: string) =>
  text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ").replace(/[&<>'"]/g, (c) => ENTITIES[c]);
const unescapeXml = (text: string) =>
  text.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) =>
    ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[name] as string);

/** Voice names and prosody values end up inside SSML attributes: only accept their real shapes. */
const VOICE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]+)+Neural$/;
const AMOUNT = /^[+-]\d{1,3}(%|Hz)$/;

export function ssml(text: string, { voice, rate, pitch, volume }: Prosody): string {
  if (!VOICE.test(voice)) throw new Error(`Not a voice name: ${voice}`);
  for (const value of [rate, pitch, volume]) if (!AMOUNT.test(value)) throw new Error(`Not a prosody value: ${value}`);
  return (
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
    `<voice name='${voice}'><prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>` +
    `${escapeXml(text)}</prosody></voice></speak>`
  );
}

/** Seam for tests. */
export const net = {
  WebSocket: globalThis.WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => WebSocket,
  fetch: globalThis.fetch,
};

let idle: WebSocket | undefined;
let parkedAt = 0;
/**
 * A socket parked longer than this is not reused: after a network change it can look open while
 * nothing arrives, which would cost a full TURN_TIMEOUT_MS before the fresh-socket fallback.
 */
const REUSE_WITHIN_MS = 15_000;

async function open(): Promise<WebSocket> {
  const url = `wss://${BASE}/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&${query()}&ConnectionId=${id()}`;
  // Node's (undici's) WebSocket takes headers; a browser's cannot set User-Agent at all.
  const socket = new net.WebSocket(url, { headers: HEADERS });
  socket.binaryType = "arraybuffer";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Speech service did not answer"));
    }, CONNECT_TIMEOUT_MS);
    socket.onopen = () => {
      clearTimeout(timer);
      socket.send(CONFIG);
      resolve();
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("Could not reach the speech service"));
    };
  });
  return socket;
}

function park(socket: WebSocket) {
  socket.onmessage = socket.onerror = null;
  socket.onclose = () => {
    if (idle === socket) idle = undefined; // the service drops quiet connections
  };
  if (idle && idle !== socket) idle.close();
  idle = socket;
  parkedAt = Date.now();
}

function turn(socket: WebSocket, text: string, prosody: Prosody): Promise<Clip> {
  const chunks: Uint8Array[] = [];
  const boundaries: Boundary[] = [];
  return new Promise<Clip>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const fail = (message: string) => {
      clearTimeout(timer);
      socket.onmessage = socket.onerror = socket.onclose = null;
      socket.close();
      reject(new Error(message));
    };
    const alive = () => {
      clearTimeout(timer);
      timer = setTimeout(() => fail("Speech service stopped answering"), TURN_TIMEOUT_MS);
    };
    alive();
    socket.onmessage = ({ data }) => {
      alive();
      if (typeof data !== "string") {
        // Binary frame: 2-byte big-endian header length, headers, then MP3 bytes.
        const bytes = new Uint8Array(data as ArrayBuffer);
        const headerLength = (bytes[0] << 8) | bytes[1];
        if (bytes.length > 2 + headerLength) chunks.push(bytes.subarray(2 + headerLength));
        return;
      }
      const split = data.indexOf("\r\n\r\n");
      const headers = data.slice(0, split);
      if (headers.includes("Path:audio.metadata")) {
        for (const item of JSON.parse(data.slice(split + 4)).Metadata) {
          if (item.Type !== "WordBoundary") continue;
          boundaries.push({ offset: item.Data.Offset, duration: item.Data.Duration, text: unescapeXml(item.Data.text.Text) });
        }
      } else if (headers.includes("Path:turn.end")) {
        clearTimeout(timer);
        park(socket);
        if (!chunks.length) return reject(new Error("No audio received from the speech service"));
        resolve({ audio: Buffer.concat(chunks), boundaries });
      }
    };
    socket.onerror = socket.onclose = () => fail("Speech service closed the connection");
    socket.send(`X-RequestId:${id()}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n${ssml(text, prosody)}`);
  });
}

/** One clip for `text`. A parked socket that has gone stale is retried once on a fresh one. */
export async function synthesize(text: string, prosody: Prosody): Promise<Clip> {
  ssml(text, prosody); // validate before touching the network
  const reused = idle;
  idle = undefined;
  if (reused && Date.now() - parkedAt >= REUSE_WITHIN_MS) reused.close();
  if (reused && reused.readyState === 1 && Date.now() - parkedAt < REUSE_WITHIN_MS) {
    try {
      return await turn(reused, text, prosody);
    } catch {
      // fall through to a fresh connection
    }
  }
  return turn(await open(), text, prosody);
}

export type Voice = { ShortName: string; Locale: string; Gender: string; FriendlyName?: string };

export async function listVoices(): Promise<Voice[]> {
  const response = await net.fetch(`https://${BASE}/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}&${query()}`, {
    headers: HEADERS,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Voice list failed: HTTP ${response.status}`);
  const voices = (await response.json()) as Voice[];
  return voices.map(({ ShortName, Locale, Gender }) => ({ ShortName, Locale, Gender }));
}

/** Closes the parked socket so the worker can exit. */
export function close() {
  idle?.close();
  idle = undefined;
}
