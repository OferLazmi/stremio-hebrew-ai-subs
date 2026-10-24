import test from "node:test";
import assert from "node:assert/strict";
import { parseSrt, serializeSrt, noticeSrt } from "../src/srt";

const CANON = `1
00:01:51,822 --> 00:01:53,790
Mr. Dufresne, describe...

2
00:01:53,991 --> 00:01:58,325
<i>...the confrontation you had with
your wife</i> the night she was murdered.

3
{\\an8}00:02:03,000 --> 00:02:04,661
x
`.replace("{\\an8}00:02:03,000", "00:02:03,000"); // keep canonical

test("canonical file round-trips byte-for-byte", () => {
  assert.equal(serializeSrt(parseSrt(CANON)), CANON);
});

test("parse is stable: parse(serialize(parse(x))) == parse(x)", () => {
  const messy = "\uFEFF1\r\n00:00:01.5 --> 00:00:02.25\r\nHello\r\n\r\n\r\n7\r\n0:00:03,000 --> 0:00:04,000 X1:10 X2:20\r\n{\\an8}Top\r\nline2\r\n\r\n";
  const a = parseSrt(messy);
  assert.equal(a.length, 2);
  assert.equal(a[0].timing, "00:00:01,500 --> 00:00:02,250");
  assert.equal(a[1].timing, "00:00:03,000 --> 00:00:04,000 X1:10 X2:20");
  assert.equal(a[1].text, "{\\an8}Top\nline2");
  assert.equal(a[1].index, 7);
  const b = parseSrt(serializeSrt(a));
  assert.deepEqual(b.map((c) => [c.timing, c.text]), a.map((c) => [c.timing, c.text]));
});

test("missing blank line between cues and missing index lines", () => {
  const s = "1\n00:00:01,000 --> 00:00:02,000\nA\n2\n00:00:03,000 --> 00:00:04,000\nB\n\n00:00:05,000 --> 00:00:06,000\nC\n";
  const c = parseSrt(s);
  assert.deepEqual(c.map((x) => x.text), ["A", "B", "C"]);
});

test("empty / garbage input gives no cues", () => {
  assert.equal(parseSrt("").length, 0);
  assert.equal(parseSrt("<html>nope</html>").length, 0);
});

test("notice SRT is a valid single cue", () => {
  const c = parseSrt(noticeSrt("AI translation failed\nreason"));
  assert.equal(c.length, 1);
  assert.equal(c[0].text, "AI translation failed\nreason");
});
