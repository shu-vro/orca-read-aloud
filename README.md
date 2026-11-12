# Read Aloud for Orca

<img src="icon.png" alt="" width="64" align="right" />

Listen to chat replies, notes and any other text in [Orca](https://orca.dev), read by Microsoft
Edge's neural voices with each word highlighted as it is spoken.

## Use

1. Open **Read Aloud** in Orca's right sidebar.
2. Copy a chat reply with its copy button and paste it into the panel (⌘V / Ctrl+V). Reading
   starts as soon as you paste. You can also type or paste any text and press **Play** or
   ⌘/Ctrl+Enter.
3. Click any sentence to read from there.

| Key | Action |
| --- | --- |
| Space | Play / pause |
| ← / → | Previous / next sentence |
| Esc | Stop |
| ⌘/Ctrl+Enter | Read the text in the box |

Under **Voice and speed** you can pick any of Edge's 300+ voices in 100+ languages and set speed,
pitch and volume. Changes are heard immediately and are remembered. Markdown syntax is skipped by
default (code blocks are announced as "code block" instead of being spelled out); turn that off to
hear the text exactly as pasted.

### Why paste and not a button on each message?

Orca's plugin API does not let plugins add buttons to chat messages or read the conversation. When
it does, this plugin will add a speaker button to each message.

## Privacy

The text you play is sent to Microsoft's Edge Read Aloud speech service
(`speech.platform.bing.com`) to be turned into speech. That is the only network request the plugin
makes. It collects nothing and sends nothing anywhere else. Your settings and the last text you
pasted stay in the plugin's own local storage in Orca.

The speech service is the one Edge's built-in Read Aloud uses. It is free and needs no account, but
it is not an official public API, so Microsoft can change or limit it at any time.

## Access

The plugin runs as **Full access** (`trusted-worker`) because Orca's panels have no network. A
small Node.js worker (`src/worker.ts`) connects to the speech service and returns the audio to the
panel. It requests no Orca capabilities: no workspace, terminal, agent or file access.

## Develop

No build step: Orca transpiles the TypeScript as it loads.

```sh
npm install          # TypeScript and Node typings, for type-checking only
orca plugin validate .
orca plugin dev watch .   # load into Orca, reload on save, stream logs
npm run typecheck
npm test             # unit tests (node:test)
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm run e2e
```

`npm run e2e` drives the real panel in headless Chromium against the real worker and the live
speech service. See [AGENTS.md](AGENTS.md) for how the code is laid out and the constraints behind it.

## License

[MIT](LICENSE)
