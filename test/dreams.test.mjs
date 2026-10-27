import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJson, normalizeAnalysis, parseTerms, patternSummaries, pseudonymize, restore } from "../lib/dreams.mjs";

test("parses terms with optional labels", () => {
  assert.deepEqual(parseTerms("Sarah\n\n Acme Corp = workplace \nMaple St=place"), [
    { term: "Sarah", label: "Person" },
    { term: "Acme Corp", label: "workplace" },
    { term: "Maple St", label: "place" },
  ]);
});

test("swaps whole words only, longest first, any case", () => {
  const terms = parseTerms("Mary\nMary Ann\nAl");
  const { text, map } = pseudonymize("Mary Ann and mary met Alice and Al.", terms);
  assert.equal(text, "Person A and Person B met Alice and Person C.");
  assert.deepEqual(map, [
    ["Person A", "Mary Ann"],
    ["Person B", "Mary"],
    ["Person C", "Al"],
  ]);
});

test("restores placeholders anywhere in the analysis, even lowercased", () => {
  const { map } = pseudonymize("Sarah was at Acme Corp", parseTerms("Sarah\nAcme Corp = workplace"));
  assert.deepEqual(map, [
    ["workplace A", "Acme Corp"],
    ["Person A", "Sarah"],
  ]);
  const back = restore({ people: ["Person A"], themes: ["chased by person a"], places: ["workplace A"] }, map);
  assert.deepEqual(back, { people: ["Sarah"], themes: ["chased by Sarah"], places: ["Acme Corp"] });
});

test("leaves text alone when there are no terms", () => {
  assert.deepEqual(pseudonymize("A quiet dream", []), { text: "A quiet dream", map: [] });
  assert.equal(restore("Person A", []), "Person A");
});

test("pulls JSON out of fences and think blocks", () => {
  const reply = '<think>{not this}</think>Here you go:\n```json\n{"title": "The flooded library"}\n```';
  assert.deepEqual(extractJson(reply), { title: "The flooded library" });
  assert.throws(() => extractJson("no json here"));
});

test("normalizes a sloppy analysis into the fixed shape", () => {
  const a = normalizeAnalysis({
    title: "  Flight  ",
    dream_type: "Nightmare",
    vividness: "9",
    emotions: ["Fear", 3, "", "awe"],
    symbols: ["Water", { symbol: "Key", note: "access" }, { note: "no symbol" }],
  });
  assert.equal(a.title, "Flight");
  assert.equal(a.dream_type, "nightmare");
  assert.equal(a.vividness, 3);
  assert.deepEqual(a.emotions, ["fear", "awe"]);
  assert.deepEqual(a.symbols, [
    { symbol: "water", note: "" },
    { symbol: "key", note: "access" },
  ]);
  assert.equal(normalizeAnalysis(null).title, "Untitled dream");
});

test("pattern summaries carry analysis only, oldest first, numbered not dated", () => {
  const analysis = (title) => normalizeAnalysis({ title, themes: ["falling"], symbols: [{ symbol: "stairs" }] });
  const dreams = [
    { date: "2026-10-02", createdAt: "b", text: "secret two", analysis: analysis("Two") },
    { date: "2026-10-01", createdAt: "a", text: "secret one", analysis: analysis("One") },
    { date: "2026-10-03", createdAt: "c", text: "unanalyzed", analysis: null },
  ];
  const items = patternSummaries(dreams, 30);
  assert.deepEqual(items.map((i) => [i.n, i.title]), [
    [1, "One"],
    [2, "Two"],
  ]);
  const sent = JSON.stringify(items);
  assert.ok(!sent.includes("secret") && !sent.includes("2026"));
});
