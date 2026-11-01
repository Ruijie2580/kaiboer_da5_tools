import { flatBands, snapshot } from "./protocol";
import {
  MAX_USER_PRESETS,
  presetName,
  qFromDrag,
  readPresets,
  removePreset,
  shouldAsk,
  upsertPreset,
} from "./edits";

function check(label: string, ok: boolean) {
  if (!ok) throw new Error(label);
}

const flat = flatBands();
check("q stays", qFromDrag(1, 0) === 1);
check("q doubles upward", qFromDrag(1, 72) === 2);
check("q halves downward", qFromDrag(1, -72) === 0.5);
check("q ceiling", qFromDrag(1, 5000) === 10);
check("q floor", qFromDrag(0.2, -5000) === 0.1);

check("clean page does not ask", shouldAsk(false, "page", "device") === false);
check("same curve does not ask", shouldAsk(true, "same", "same") === false);
check("dirty mismatch asks", shouldAsk(true, "page", "device") === true);

check("name trims", presetName("  夜间听  ") === "夜间听");
check("name limit", presetName("一二三四五六七八九十甲乙丙丁戊己庚") === "一二三四五六七八九十甲乙丙丁戊己");

const saved = upsertPreset([], { name: " 低音 ", preamp: -3, bands: flat });
if (saved === "full") throw new Error("first preset");
check("stored name", saved[0].name === "低音" && saved[0].preamp === -3);
const replaced = upsertPreset(saved, { name: "低音", preamp: -6, bands: flat });
if (replaced === "full") throw new Error("replace");
check("overwrite", replaced.length === 1 && replaced[0].preamp === -6);

let full = saved;
for (let index = 0; index < MAX_USER_PRESETS - 1; index += 1) {
  const next = upsertPreset(full, { name: `p${index}`, preamp: 0, bands: flat });
  if (next === "full") throw new Error("fill");
  full = next;
}
check("full", upsertPreset(full, { name: "extra", preamp: 0, bands: flat }) === "full");
check("remove", removePreset(saved, "低音").length === 0);

const raw = JSON.stringify([
  { name: " 人声 ", preamp: 3, bands: [{ type: "NOPE", freq: 10, gain: 99, q: 0 }] },
  { name: "", preamp: 0, bands: flat },
  "bad",
]);
const loaded = readPresets(raw);
check("read one", loaded.length === 1);
check("read clamp", loaded[0].name === "人声" && loaded[0].preamp === 0);
check("read band", loaded[0].bands.length === 10 && loaded[0].bands[0].type === "PK");
check("read gain", loaded[0].bands[0].gain === 12 && loaded[0].bands[0].freq === 20);
check("garbage", readPresets("not json").length === 0);
check("snap stable", snapshot(loaded[0].preamp, loaded[0].bands) === snapshot(0, loaded[0].bands));

console.log("edits ok");
