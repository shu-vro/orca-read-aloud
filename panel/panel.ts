/**
 * The panel: text in, sound out. The frame has no network, so each sentence's audio comes from
 * the plugin's worker (`plugin.request('speak')`) and is played here.
 *
 * Sound goes through one AudioContext that keeps running between sentences, each clip scheduled
 * as an AudioBufferSourceNode. A media element per sentence swallows the start of each clip and
 * cannot cut the service's trailing second of silence without cutting the last word.
 */

import { align, signed, splitSentences, stripMarkdown, voiceName, wordAt, type Boundary, type Sentence, type Word } from "../src/text.ts";

/** Sentences synthesized ahead of the one playing, one request at a time (the service throttles bursts). */
const PREFETCH = 2;
const CACHE_SIZE = 40;
/** Pause after a sentence's last word. Clips end with ~1 s of silence, so their own end is not used. */
const SENTENCE_GAP = 0.35;
const REQUEST_TIMEOUT_MS = 60_000;
const VOICES_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const defaults = {
  voice: "en-US-AvaMultilingualNeural",
  /** Percent relative to the voice's normal speed. */
  rate: 0,
  /** Hz relative to the voice's normal pitch. */
  pitch: 0,
  /** Percent relative to normal loudness. */
  volume: 0,
  autoRead: true,
  wordHighlight: true,
  stripMarkdown: true,
};
type Settings = typeof defaults;
type Voice = { ShortName: string; Locale: string; Gender: string };
type Clip = { buffer: AudioBuffer; words: Word[]; length: number };

// localStorage persists per plugin in Orca's frames, but can still throw: never let it break the panel.
const load = <T>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
};
const save = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage full or unavailable: settings just won't survive a reload
  }
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  status: $("status"),
  toggle: $<HTMLButtonElement>("toggle"),
  prev: $<HTMLButtonElement>("prev"),
  next: $<HTMLButtonElement>("next"),
  stop: $<HTMLButtonElement>("stop"),
  input: $<HTMLTextAreaElement>("input"),
  reader: $("reader"),
  edit: $<HTMLButtonElement>("edit"),
  clear: $<HTMLButtonElement>("clear"),
  voice: $<HTMLSelectElement>("voice"),
  reset: $<HTMLButtonElement>("reset"),
};

let settings: Settings = { ...defaults, ...load<Partial<Settings>>("settings", {}) };

const context = new AudioContext();
const cache = new Map<string, Promise<Clip>>();
/** Requests not yet answered, so ones nobody will hear can be dropped from the worker's queue. */
const inflight = new Map<string, { index: number; controller: AbortController }>();

/** Cancels requests outside `[from, from + PREFETCH]`, or all of them without `from`. */
function cancel(from?: number) {
  for (const [key, { index: i, controller }] of inflight) {
    if (from !== undefined && i >= from && i <= from + PREFETCH) continue;
    controller.abort();
    cache.delete(key);
    inflight.delete(key);
  }
}

let sentences: Sentence[] = [];
let spans: HTMLSpanElement[] = [];
let index = 0;
/** Bumped on every seek or stop, so work started for an earlier position knows it is stale. */
let generation = 0;
let current: Clip | undefined;
/** The clip while it is sounding; undefined when paused, loading or stopped. */
let node: AudioBufferSourceNode | undefined;
/** Context time at which the current clip's zero falls. */
let startedAt = 0;
/** Position in the current clip to resume from. */
let offset = 0;
let state: "idle" | "loading" | "playing" | "paused" = "idle";
/** Whether the highlight loop is scheduled; one loop at most, however often a clip starts. */
let following = false;

const wordHighlight = "Highlight" in window && CSS.highlights ? new Highlight() : undefined;
if (wordHighlight) CSS.highlights.set("read-aloud-word", wordHighlight);

function setStatus(text: string, error = false) {
  ui.status.textContent = text;
  ui.status.classList.toggle("error", error);
  ui.status.title = text;
}

function setState(next: typeof state) {
  state = next;
  const active = next !== "idle";
  document.body.classList.toggle("playing", next === "playing" || next === "loading");
  const label = next === "playing" || next === "loading" ? "Pause" : "Read";
  ui.toggle.setAttribute("aria-label", label);
  ui.toggle.title = `${label} (Space)`;
  ui.stop.disabled = !active;
  ui.prev.disabled = !active || index <= 0;
  ui.next.disabled = !active || index >= sentences.length - 1;
  const progress = active && sentences.length ? ((index + (next === "playing" ? 1 : 0)) / sentences.length) * 100 : 0;
  $("progress").style.width = `${progress}%`;
  if (next === "playing") setStatus(`Sentence ${index + 1} of ${sentences.length}`);
  if (next === "loading") setStatus("Loading…");
  if (next === "paused") setStatus("Paused");
}

function errorText(error: unknown): string {
  const { code, message } = (error ?? {}) as { code?: string; message?: string };
  if (code === "unavailable") return "The plugin's worker could not start. Is the plugin enabled?";
  if (code === "timeout") return "The speech service took too long to answer.";
  return message || String(error);
}

// ---------- text ----------

/** Shows `text` as clickable sentences in place of the text box. */
function showReader(text: string) {
  sentences = splitSentences(text);
  ui.reader.replaceChildren();
  spans = [];
  let at = 0;
  sentences.forEach((sentence, i) => {
    if (sentence.from > at) ui.reader.append(text.slice(at, sentence.from));
    const span = document.createElement("span");
    span.textContent = sentence.text;
    span.addEventListener("click", () => {
      // Never hijack a text selection.
      if (getSelection()?.isCollapsed !== false) start(i);
    });
    ui.reader.append(span);
    spans.push(span);
    at = sentence.to;
  });
  if (at < text.length) ui.reader.append(text.slice(at));
  ui.reader.hidden = false;
  ui.input.hidden = true;
  ui.edit.hidden = false;
}

function showEditor() {
  stop();
  ui.reader.hidden = true;
  ui.input.hidden = false;
  ui.edit.hidden = true;
  ui.input.focus();
}

function prepare(): boolean {
  const raw = ui.input.value;
  save("text", raw);
  const text = settings.stripMarkdown ? stripMarkdown(raw) : raw.trim();
  showReader(text);
  if (!sentences.length) {
    showEditor();
    setStatus("Nothing to read. Paste some text first.");
    return false;
  }
  return true;
}

// ---------- audio ----------

function decodeBase64(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function make(text: string, { voice, rate, pitch, volume }: Settings, signal: AbortSignal): Promise<Clip> {
  const { audio, boundaries } = (await orca.plugin.request(
    "speak",
    { text, voice, rate: signed(rate, "%"), pitch: signed(pitch, "Hz"), volume: signed(volume, "%") },
    { timeoutMs: REQUEST_TIMEOUT_MS, signal },
  )) as { audio: string; boundaries: Boundary[] };
  const buffer = await context.decodeAudioData(decodeBase64(audio));
  const words = align(text, boundaries);
  const last = words.at(-1);
  const length = last ? Math.min(buffer.duration, last.end + SENTENCE_GAP) : buffer.duration;
  return { buffer, words, length };
}

function clip(i: number): Promise<Clip> {
  const { voice, rate, pitch, volume } = settings;
  const key = [voice, rate, pitch, volume, sentences[i].text].join("|");
  let pending = cache.get(key);
  cache.delete(key);
  if (!pending) {
    const controller = new AbortController();
    pending = make(sentences[i].text, settings, controller.signal);
    inflight.set(key, { index: i, controller });
    pending.catch(() => cache.delete(key)).finally(() => inflight.get(key)?.controller === controller && inflight.delete(key));
  }
  cache.set(key, pending); // re-inserted last: most recently used
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return pending;
}

async function prefetch(from: number, mine: number) {
  for (let i = from + 1; i <= from + PREFETCH && i < sentences.length; i++) {
    if (mine !== generation) return;
    await clip(i).catch(() => {});
  }
}

function silence() {
  if (!node) return;
  node.onended = null;
  node.stop();
  node = undefined;
}

/** Sounds the current clip from `offset`. */
function sound() {
  const playing = current!;
  const source = (node = context.createBufferSource());
  source.buffer = playing.buffer;
  source.connect(context.destination);
  source.onended = () => {
    if (node === source) play(index + 1);
  };
  startedAt = context.currentTime - offset;
  source.start(0, offset, Math.max(0, playing.length - offset));
  setState("playing");
  if (!following) {
    following = true;
    requestAnimationFrame(follow);
  }
}

function mark(i: number) {
  spans.forEach((span, j) => span.classList.toggle("current", j === i));
  const span = spans[i];
  if (!span) return;
  const box = span.getBoundingClientRect();
  const view = ui.reader.getBoundingClientRect();
  if (box.top < view.top || box.bottom > view.bottom) {
    const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches;
    span.scrollIntoView({ block: "nearest", behavior: smooth ? "smooth" : "auto" });
  }
}

/** Moves the word highlight on the animation clock; one frame per frame, no messages per word. */
function follow() {
  wordHighlight?.clear();
  if (!wordHighlight || state !== "playing" || !current || !settings.wordHighlight) {
    following = false;
    return;
  }
  // What is heard trails the context clock by the output latency; the highlight should too.
  const time = context.currentTime - startedAt - (context.outputLatency || 0);
  const word = current.words[wordAt(current.words, time)];
  const text = spans[index]?.firstChild;
  if (word && word.from >= 0 && text && time <= word.end + 0.15) {
    const range = new Range();
    range.setStart(text, word.from);
    range.setEnd(text, Math.min(word.to, text.textContent!.length));
    wordHighlight.add(range);
  }
  requestAnimationFrame(follow);
}

async function play(i: number) {
  const mine = ++generation;
  // Skipping through sentences must not leave the one landed on queued behind the ones passed.
  cancel(i);
  silence();
  current = undefined;
  if (i >= sentences.length) return finish();
  index = i;
  mark(i);
  setState("loading");
  try {
    const ready = await clip(i);
    if (mine !== generation) return;
    current = ready;
    offset = 0;
    sound();
    prefetch(i, mine);
  } catch (error) {
    if (mine !== generation) return;
    setState("paused");
    setStatus(errorText(error), true);
  }
}

function finish() {
  generation++;
  silence();
  current = undefined;
  wordHighlight?.clear();
  spans.forEach((span) => span.classList.remove("current"));
  index = 0;
  setState("idle");
  setStatus("Finished");
  $("progress").style.width = "100%";
  context.suspend(); // nothing to play: let the output device go
}

function stop() {
  if (state === "idle") return;
  finish();
  setStatus("Ready");
  $("progress").style.width = "0%";
}

function start(i = 0) {
  context.resume(); // needs the click or key press that got us here
  play(i);
}

function pause() {
  if (state === "loading") {
    generation++; // don't start when it arrives
  } else if (node) {
    offset = context.currentTime - startedAt;
    silence();
  }
  setState("paused");
  wordHighlight?.clear();
}

function resume() {
  context.resume();
  if (current) sound();
  else play(index);
}

function toggle() {
  if (state === "playing" || state === "loading") return pause();
  if (state === "paused") return resume();
  if (ui.reader.hidden && !prepare()) return;
  start(0);
}

function seek(delta: number) {
  if (state === "idle") return;
  const target = index + delta;
  if (target >= 0 && target < sentences.length) start(target);
}

// ---------- controls ----------

ui.toggle.addEventListener("click", toggle);
ui.stop.addEventListener("click", stop);
ui.prev.addEventListener("click", () => seek(-1));
ui.next.addEventListener("click", () => seek(1));
ui.edit.addEventListener("click", showEditor);
ui.clear.addEventListener("click", () => {
  ui.input.value = "";
  save("text", "");
  showEditor();
  setStatus("Ready");
});

ui.input.value = load("text", "");
ui.input.addEventListener("input", () => save("text", ui.input.value));
ui.input.addEventListener("paste", () => {
  if (!settings.autoRead || ui.input.value.trim()) return;
  // Let the paste land in the box first; the paste is the user gesture audio needs.
  setTimeout(() => prepare() && start(0));
});
ui.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    if (prepare()) start(0);
  }
});

document.addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement;
  if (target.closest("textarea, input, select, summary, button") || event.metaKey || event.ctrlKey || event.altKey) return;
  const actions: Record<string, () => void> = {
    " ": toggle,
    ArrowLeft: () => seek(-1),
    ArrowRight: () => seek(1),
    Escape: stop,
  };
  const action = actions[event.key];
  if (!action) return;
  event.preventDefault();
  action();
});

// ---------- settings ----------

function setSettings(patch: Partial<Settings>) {
  const before = settings;
  settings = { ...settings, ...patch };
  save("settings", settings);
  render();
  const audible = (["voice", "rate", "pitch", "volume"] as const).some((k) => before[k] !== settings[k]);
  // New voice or prosody: restart the current sentence so the change is heard at once.
  if (audible) cancel(); // requests made with the old voice or prosody
  if (audible && (state === "playing" || state === "loading")) play(index);
  else if (audible && state === "paused") current = undefined;
}

/** Speed reads better as a multiplier: +25% is shown as 1.25×. */
const speed = (rate: number) => `${(1 + rate / 100).toFixed(2).replace(/\.?0+$/, "")}×`;
const sliders = {
  rate: speed,
  pitch: (n: number) => `${signed(n, "")} Hz`,
  volume: (n: number) => `${signed(n, "")}%`,
} as const;
type Slider = keyof typeof sliders;
const SPEED_PRESETS = [-25, 0, 25, 50, 100];

/** Shows a slider's value and fills its track up to the thumb. */
function paint(key: Slider, value: number) {
  const input = $<HTMLInputElement>(key);
  const fill = ((value - Number(input.min)) / (Number(input.max) - Number(input.min))) * 100;
  input.style.setProperty("--fill", `${fill}%`);
  $(`${key}-out`).textContent = sliders[key](value);
  if (key === "rate") for (const chip of $("presets").children) chip.setAttribute("aria-pressed", String(Number((chip as HTMLElement).dataset.rate) === value));
}

function render() {
  for (const key of Object.keys(sliders) as Slider[]) {
    $<HTMLInputElement>(key).value = String(settings[key]);
    paint(key, settings[key]);
  }
  for (const key of ["autoRead", "wordHighlight", "stripMarkdown"] as const) $<HTMLInputElement>(key).checked = settings[key];
  if ([...ui.voice.options].some((o) => o.value === settings.voice)) ui.voice.value = settings.voice;
}

$("presets").append(
  ...SPEED_PRESETS.map((rate) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.dataset.rate = String(rate);
    chip.textContent = speed(rate);
    chip.addEventListener("click", () => setSettings({ rate }));
    return chip;
  }),
);
for (const key of Object.keys(sliders) as Slider[]) {
  const input = $<HTMLInputElement>(key);
  // `input` updates the label while dragging; `change` re-synthesizes once, on release.
  input.addEventListener("input", () => paint(key, Number(input.value)));
  input.addEventListener("change", () => setSettings({ [key]: Number(input.value) }));
}
for (const key of ["autoRead", "wordHighlight", "stripMarkdown"] as const) {
  $<HTMLInputElement>(key).addEventListener("change", (event) => setSettings({ [key]: (event.target as HTMLInputElement).checked }));
}
// Remember whether the settings card was left open.
const card = $<HTMLDetailsElement>("settings");
card.open = load("settingsOpen", false);
card.addEventListener("toggle", () => save("settingsOpen", card.open));
ui.voice.addEventListener("change", () => setSettings({ voice: ui.voice.value }));
ui.reset.addEventListener("click", () => setSettings({ ...defaults }));

// ---------- voices ----------

const languageNames = new Intl.DisplayNames([orca.locale || navigator.language], { type: "language" });
const localeName = (locale: string) => {
  try {
    return languageNames.of(locale) ?? locale;
  } catch {
    return locale;
  }
};

function showVoices(voices: Voice[]) {
  const groups = Map.groupBy(voices, (v) => localeName(v.Locale));
  ui.voice.replaceChildren(
    ...[...groups]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([language, list]) => {
        const group = document.createElement("optgroup");
        group.label = language;
        for (const v of list) group.append(new Option(`${voiceName(v.ShortName, v.Locale)} (${v.Gender})`, v.ShortName));
        return group;
      }),
  );
  if (!voices.some((v) => v.ShortName === settings.voice)) setSettings({ voice: defaults.voice });
  render();
}

async function loadVoices() {
  const cached = load<{ at: number; voices: Voice[] } | null>("voices", null);
  if (cached?.voices.length) showVoices(cached.voices);
  if (cached && Date.now() - cached.at < VOICES_MAX_AGE_MS) return;
  try {
    const voices = (await orca.plugin.request("voices", undefined, { timeoutMs: REQUEST_TIMEOUT_MS })) as Voice[];
    save("voices", { at: Date.now(), voices });
    showVoices(voices);
  } catch (error) {
    if (cached) return; // stale beats nothing
    ui.voice.replaceChildren(new Option(settings.voice, settings.voice));
    setStatus(`Could not load voices: ${errorText(error)}`, true);
  }
}

render();
setState("idle");
loadVoices();
