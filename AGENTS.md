# AGENTS.md

Guidance for coding agents. The README covers use; this file covers how the code works and the
constraints that are not obvious from reading it.

## What this is

An Orca plugin (`orca-plugin.json`, manifest format 2, `trusted-worker`) that reads text aloud
through Microsoft Edge's Read Aloud speech service. Plain TypeScript, no build step (Orca
transpiles `.ts` on load), no runtime dependencies. Ported from the `shirshen-tts-ext` browser
extension, which shares the speech client, token generator, alignment and player design.

## Layout

| File | Runs in | Owns |
| --- | --- | --- |
| `panel/index.html`, `panel/panel.ts`, `panel/style.css` | Orca's isolated panel frame | UI, sentence list, AudioContext playback, prefetch, clip cache, word highlight, settings (localStorage) |
| `src/worker.ts` | Plugin's Node worker | `speak` and `voices` handlers, retries, one-at-a-time queue |
| `src/tts.ts` | Worker | Speech WebSocket, socket reuse, voice list |
| `src/gec.ts` | Worker | `Sec-MS-GEC` token |
| `src/text.ts` | Panel and tests | Markdown stripping, sentence split, boundary alignment |

Flow: the panel splits the text into sentences, asks the worker for one with
`orca.plugin.request('speak', …)`, gets back base64 MP3 and word boundaries, decodes and plays it,
and prefetches the next two.

## Constraints

**Orca**

- Panel frames have no network. Only the worker can reach the speech service, which is why the
  plugin is `trusted-worker`. It declares no capabilities. Keep it that way unless a feature
  really needs one, because each one is shown to the user at install.
- There is no plugin API for chat messages: no toolbar contribution, no message text. The paste
  flow is the workaround. Re-check `docs/reference/plugin-manifest.md` in stablyai/orca for a
  chat contribution point before adding anything hacky.
- `navigator.clipboard` is denied in frames. A real paste (⌘V) into the textarea works.
- `plugin.request` inputs are capped at 64 KiB and answers at 1 MiB (JSON). Sentences are kept at
  300 characters or fewer (`src/text.ts`), and the worker refuses more than 2,000.
- `orca plugin shot --act` refuses html panels, so `test/e2e.ts` drives the panel in headless
  Chromium with a stand-in `window.orca` instead.

**The speech service** (same as the extension)

- It answers `403` unless the `User-Agent` is Edge's. Node's (undici's) WebSocket accepts a
  `headers` option, which browsers do not. `GEC_VERSION` in `src/tts.ts` sets both the token
  version and the User-Agent's Edge version. When synthesis starts failing, check this first, then
  the token scheme in `gec.ts` against rany2/edge-tts `drm.py`.
- It queues clients that send bursts. The worker therefore sends one request at a time, whatever
  the panel asks for, and the panel prefetches only two sentences ahead. Do not parallelize this.
- A handshake costs about twice a sentence, so one socket is parked and reused. A stale one is
  retried once on a fresh socket, and failures are retried with 0.5, 1 and 2 s backoff.
- Clips end with about 1 s of silence. They are played only up to the last word plus `SENTENCE_GAP`.
- This is an undocumented endpoint. Do not add features that hammer it (bulk export,
  whole-document pre-synthesis).

**Audio and UI**

- Use one AudioContext and an `AudioBufferSourceNode` per clip. Do not use an `<audio>` element per
  sentence: it clips the start of each sentence and cannot trim the silence cleanly.
- The word highlight is the CSS Custom Highlight API, moved on `requestAnimationFrame` and offset by
  `outputLatency`.
- Colours come only from `--orca-*` variables, and motion is disabled under `prefers-reduced-motion`.
- Validate voice and prosody before they go into SSML attributes (`ssml()` in `tts.ts`). The text
  is XML-escaped.

## Commands

```sh
npm test            # unit tests, node:test, no network
npm run typecheck   # needs `npm install` and `orca plugin types .`
npm run e2e         # live: headless Chromium + speech service; set CHROME to a Chromium binary
orca plugin validate .
orca plugin dev load .   # then `orca plugin dev request . voices` calls the worker directly
```

Run `npm test`, `npm run typecheck` and `orca plugin validate .` before calling a change done. Run
`npm run e2e` for anything touching playback or the panel.

## Conventions

- Conventional commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`).
- Comments explain why, not what. Deliberate shortcuts are marked `ponytail:` with their limit.
- No framework and no runtime dependency for something a few lines can do.
