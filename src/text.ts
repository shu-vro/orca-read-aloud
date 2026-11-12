/**
 * Turning pasted chat text into what gets spoken, and lining the spoken words back up with it.
 * Pure functions, shared by the panel and the tests.
 */

/** Sentences longer than this are split at a comma or space, so the first audio arrives quickly. */
const MAX_SENTENCE = 300;

/**
 * Chat replies are Markdown. Reading out `**`, `#` and fenced code is noise, so the syntax goes and
 * the words stay. Code blocks are replaced by a short note rather than read symbol by symbol.
 */
export function stripMarkdown(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, "\n")
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?(^\1[ \t]*$|(?![\s\S]))/gm, "(code block)\n")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images: keep the alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links: keep the label
    .replace(/<\/?[a-z][^>\n]*>/gi, "") // inline HTML tags
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]{0,3}>[ \t]?/gm, "")
    .replace(/^[ \t]*([-*+]|\d+[.)])[ \t]+/gm, "")
    .replace(/^[ \t]*([-*_][ \t]*){3,}$/gm, "")
    .replace(/^\|?[ \t]*:?-{3,}.*$/gm, "") // table separator rows
    .replace(/[ \t]*\|[ \t]*/g, ", ") // table cells
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(^|[^\w*])[*_](?=\S)([^*_\n]*?\S)[*_](?!\w)/g, "$1$2")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type Sentence = { text: string; from: number; to: number };

const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });

/** Splits `text` into speakable pieces, each with its character span in `text`. */
export function splitSentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  const push = (from: number, to: number) => {
    // Trim the span itself so highlights cover only visible characters.
    while (from < to && /\s/.test(text[from])) from++;
    while (to > from && /\s/.test(text[to - 1])) to--;
    if (/[\p{L}\p{N}]/u.test(text.slice(from, to))) out.push({ text: text.slice(from, to), from, to });
  };
  // Line breaks end a sentence too: list items and headings often have no full stop.
  for (const line of text.matchAll(/[^\n]+/g)) {
    for (const { segment, index } of segmenter.segment(line[0])) {
      let from = line.index + index;
      const end = from + segment.length;
      while (end - from > MAX_SENTENCE) {
        const window = text.slice(from, from + MAX_SENTENCE);
        const cut = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(": "));
        const at = cut > MAX_SENTENCE / 3 ? cut + 1 : window.lastIndexOf(" ") > 0 ? window.lastIndexOf(" ") : MAX_SENTENCE;
        push(from, from + at);
        from += at;
      }
      push(from, end);
    }
  }
  return out;
}

/** Edge reports time in 100-nanosecond units. */
const HNS_PER_SECOND = 1e7;
/** A boundary found further ahead than this is a false match, not the next word. */
const MAX_SKIP = 60;

export type Boundary = { offset: number; duration: number; text: string };
export type Word = {
  /** Seconds from the start of the clip. */
  start: number;
  end: number;
  /** Character span in the sentence, or -1/-1 when the spoken word could not be located. */
  from: number;
  to: number;
};

/**
 * Lines the service's word boundaries up with character offsets in the text that was sent.
 * Boundaries carry the word but not where it came from, so each one is searched for forward
 * from the end of the previous match.
 */
export function align(text: string, boundaries: Boundary[]): Word[] {
  const haystack = text.toLowerCase();
  let cursor = 0;
  return boundaries.map((b) => {
    const start = b.offset / HNS_PER_SECOND;
    const end = (b.offset + b.duration) / HNS_PER_SECOND;
    const at = haystack.indexOf(b.text.toLowerCase(), cursor);
    if (at < 0 || at - cursor > MAX_SKIP) return { start, end, from: -1, to: -1 };
    cursor = at + b.text.length;
    return { start, end, from: at, to: cursor };
  });
}

/** Index of the word being spoken at `time`, or -1 before the first one. */
export function wordAt(words: Word[], time: number): number {
  let i = -1;
  while (i + 1 < words.length && words[i + 1].start <= time) i++;
  return i;
}

/** 10 -> "+10%", the form the service takes prosody in. */
export const signed = (n: number, unit: string) => `${n >= 0 ? "+" : ""}${Math.round(n)}${unit}`;

/** "en-US-EmmaMultilingualNeural" -> "Emma Multilingual". */
export const voiceName = (shortName: string, locale: string) =>
  shortName.slice(locale.length + 1).replace(/Neural$/, "").replace(/([a-z])([A-Z])/g, "$1 $2");
