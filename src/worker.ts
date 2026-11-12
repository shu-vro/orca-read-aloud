/**
 * The plugin's worker: the only part with network access. The panel asks it for one clip at a
 * time with `plugin.request('speak')` and plays the audio itself.
 */

import type { Activate } from "orca/worker";
import { close, listVoices, synthesize, type Prosody } from "./tts.ts";

/** Tries per clip. The wait before each retry doubles, so a throttling service is not pushed harder. */
const ATTEMPTS = 4;
const RETRY_DELAY_MS = 500;
/** Matches the panel's longest piece with room to spare; anything bigger is not from our panel. */
const MAX_TEXT = 2000;

type SpeakInput = Prosody & { text: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The service queues clients that send bursts, delaying every answer by seconds. Requests
 * therefore go out one at a time, whatever the panel asks for.
 */
let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(job: () => Promise<T>): Promise<T> => {
  const next = queue.then(job, job);
  queue = next.catch(() => {});
  return next;
};

function invalid(message: string): Error {
  return Object.assign(new Error(message), { code: "invalid_params" });
}

export async function speak(input: unknown, signal?: AbortSignal) {
  const { text, voice, rate, pitch, volume } = (input ?? {}) as Partial<SpeakInput>;
  if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT) throw invalid("text must be 1-2000 characters");
  if (![voice, rate, pitch, volume].every((v) => typeof v === "string")) throw invalid("voice, rate, pitch and volume are strings");
  const prosody = { voice, rate, pitch, volume } as Prosody;
  return serial(async () => {
    for (let attempt = 1; ; attempt++) {
      if (signal?.aborted) throw Object.assign(new Error("cancelled"), { code: "cancelled" });
      try {
        const { audio, boundaries } = await synthesize(text, prosody);
        // Answers are JSON; at 48 kbit/s a 300-character sentence is far under the 1 MiB cap.
        return { audio: Buffer.from(audio).toString("base64"), boundaries };
      } catch (error) {
        if (attempt >= ATTEMPTS || /Not a (voice|prosody)/.test(String(error))) throw error;
        await sleep(RETRY_DELAY_MS * 2 ** (attempt - 1));
      }
    }
  });
}

const activate: Activate = (orca) => {
  orca.panels.handle("speak", (input, { signal }) => speak(input, signal));
  orca.panels.handle("voices", () => listVoices());
};

export default activate;
export const deactivate = close;
