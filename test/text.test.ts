import { test } from "node:test";
import assert from "node:assert/strict";
import { align, signed, splitSentences, stripMarkdown, voiceName, wordAt } from "../src/text.ts";

const b = (text: string, i: number) => ({ text, offset: i * 1e7, duration: 5e6 });

test("align maps boundaries to character spans, forward only", () => {
  const text = "The cat saw the other cat.";
  const words = align(text, ["The", "cat", "saw", "the", "other", "cat"].map(b));
  assert.deepEqual(words.map((w) => text.slice(w.from, w.to)), ["The", "cat", "saw", "the", "other", "cat"]);
  assert.equal(words[5].from, 22); // the second "cat", not the first
  assert.equal(words[1].start, 1);
  assert.equal(words[1].end, 1.5);
});

test("align skips a word it cannot find without derailing the rest", () => {
  const text = "It cost $5 today.";
  const words = align(text, ["It", "cost", "five dollars", "today"].map(b));
  assert.equal(words[2].from, -1);
  assert.equal(text.slice(words[3].from, words[3].to), "today");
});

test("wordAt", () => {
  const words = align("a b c", ["a", "b", "c"].map(b));
  assert.equal(wordAt(words, -0.1), -1);
  assert.equal(wordAt(words, 0), 0);
  assert.equal(wordAt(words, 1.2), 1);
  assert.equal(wordAt(words, 99), 2);
});

test("splitSentences gives spans that point back into the text", () => {
  const text = "First one. Second one?\n- item without stop\n\n  Third!  ";
  const sentences = splitSentences(text);
  assert.deepEqual(sentences.map((s) => s.text), ["First one.", "Second one?", "- item without stop", "Third!"]);
  for (const s of sentences) assert.equal(text.slice(s.from, s.to), s.text);
});

test("splitSentences drops pieces with nothing to say", () => {
  assert.deepEqual(splitSentences("---\n\n...\n"), []);
});

test("splitSentences breaks long sentences, preferring commas", () => {
  const long = Array.from({ length: 40 }, (_, i) => `clause number ${i}`).join(", ") + ".";
  const parts = splitSentences(long);
  assert.ok(parts.length > 1);
  for (const p of parts) {
    assert.ok(p.text.length <= 300, `too long: ${p.text.length}`);
    assert.equal(long.slice(p.from, p.to), p.text);
  }
  assert.ok(parts[0].text.endsWith(","));
  const unbroken = "x".repeat(700);
  assert.equal(splitSentences(unbroken).map((p) => p.text).join(""), unbroken);
});

test("stripMarkdown keeps the words and drops the syntax", () => {
  const md = [
    "# Title",
    "",
    "Some **bold**, _italic_ and `code` with a [link](https://x.y).",
    "",
    "```js",
    "const a = 1;",
    "```",
    "",
    "- one",
    "2. two",
    "> quoted",
    "",
    "| a | b |",
    "|---|---|",
    "",
    "snake_case_name stays, 2 * 3 * 4 too.",
  ].join("\n");
  const out = stripMarkdown(md);
  assert.match(out, /^Title\n/);
  assert.match(out, /Some bold, italic and code with a link\./);
  assert.match(out, /\(code block\)/);
  assert.doesNotMatch(out, /const a/);
  assert.match(out, /^one$/m);
  assert.match(out, /^two$/m);
  assert.match(out, /^quoted$/m);
  assert.match(out, /snake_case_name stays, 2 \* 3 \* 4 too\./);
  assert.doesNotMatch(out, /[#`]/);
});

test("stripMarkdown drops an unclosed code fence to the end", () => {
  assert.equal(stripMarkdown("Look:\n```\nrm -rf /\n"), "Look:\n(code block)");
});

test("signed and voiceName", () => {
  assert.equal(signed(10, "%"), "+10%");
  assert.equal(signed(-5, "Hz"), "-5Hz");
  assert.equal(signed(0, "%"), "+0%");
  assert.equal(voiceName("en-US-EmmaMultilingualNeural", "en-US"), "Emma Multilingual");
});
