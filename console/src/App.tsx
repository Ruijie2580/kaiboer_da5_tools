import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { DeviceDialog } from "./components/DeviceDialog";
import { EqPlot } from "./components/EqPlot";
import { Fader } from "./components/Fader";
import {
  PRESET_STORAGE_KEY,
  type StoredPreset,
  presetName,
  readPresets,
  removePreset,
  upsertPreset,
} from "./hid/edits";
import { useDa5 } from "./hid/useDa5";
import {
  FILTERS,
  PRESETS,
  TYPE_LABEL,
  formatHz,
  type FilterType,
} from "./hid/protocol";

const hintIdle = "拖动圆点：左右改频率，上下改增益。按住 Shift 上下改 Q。";

function Screws() {
  return (
    <>
      <span className="screw left-2 top-2" />
      <span className="screw right-2 top-2" />
      <span className="screw bottom-2 left-2" />
      <span className="screw bottom-2 right-2" />
    </>
  );
}

export function App() {
  const dac = useDa5();
  const fileRef = useRef<HTMLInputElement>(null);
  const [askWrite, setAskWrite] = useState(false);
  const [askSave, setAskSave] = useState(false);
  const [presetDraft, setPresetDraft] = useState("");
  const [presetError, setPresetError] = useState("");
  const [hint, setHint] = useState(hintIdle);
  const [preset, setPreset] = useState("");
  const [userPresets, setUserPresets] = useState<StoredPreset[]>(() => {
    try {
      return readPresets(localStorage.getItem(PRESET_STORAGE_KEY));
    } catch {
      return [];
    }
  });
  const band = dac.bands[dac.selected];
  const activeUser = preset.startsWith("user:") ? preset.slice(5) : "";

  useEffect(() => {
    try {
      localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(userPresets));
    } catch {
      setPresetError("这个浏览器没能存下预设");
    }
  }, [userPresets]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      const typing = target instanceof HTMLElement && target.matches("input, textarea");
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && !event.shiftKey) {
        if (event.type !== "keydown" || typing) return;
        event.preventDefault();
        setPreset("");
        dac.undo();
        return;
      }
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        if (event.type === "keyup") {
          dac.endGesture();
          return;
        }
        if (target instanceof HTMLElement && target.matches("input, select, textarea, button")) return;
        event.preventDefault();
        if (!event.repeat) dac.checkpoint("keys");
        const step = event.shiftKey ? 1 : 0.1;
        const current = dac.bands[dac.selected];
        setPreset("");
        dac.editBand(dac.selected, {
          gain: current.gain + (event.key === "ArrowUp" ? step : -step),
        });
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    };
  }, [dac]);

  function saveUserPreset() {
    const name = presetName(presetDraft);
    if (!name) {
      setPresetError("先写一个名字");
      return;
    }
    const next = upsertPreset(userPresets, {
      name,
      preamp: dac.preamp,
      bands: dac.bands.map((item) => ({ ...item })),
    });
    if (next === "full") {
      setPresetError("最多保存 16 个预设");
      return;
    }
    setUserPresets(next);
    setPreset(`user:${name}`);
    setAskSave(false);
  }

  const ledClass = dac.busy ? "led busy" : dac.connected ? "led on" : "led";
  const linkText = dac.filePage
    ? "请从启动脚本打开"
    : !dac.supported
      ? "请用 Edge 或 Chrome"
      : dac.status || (dac.connected ? "已连接" : "未连接");

  return (
    <div className="mx-auto flex h-dvh max-w-[1240px] flex-col gap-3 overflow-auto p-3 lg:overflow-hidden">
      <header className="faceplate flex flex-wrap items-center justify-between gap-3 rounded-2xl px-4 py-3">
        <Screws />
        <div className="flex items-center gap-3 pl-3">
          <div className="grid h-12 w-12 place-items-center rounded-xl border border-sky-700/25 bg-gradient-to-b from-white/80 to-slate-200/80 text-[15px] font-semibold text-sky-800">
            DA5
          </div>
          <div>
            <h1 className="text-lg font-semibold leading-6">开博尔 DA5</h1>
            <p className="text-[13px] leading-5 text-slate-500">机身 10 段参量均衡。写入后，换电脑或插到手机仍然有效。</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 pr-3">
          <div className="vfd min-w-[168px] rounded-md px-3 py-2 text-[13px] leading-6">
            <div>KAIBOER DA5</div>
            <div>{dac.connected ? `FW ${dac.firmware || "--"}` : "NO LINK"}</div>
            <div>PEQ 10 BAND</div>
          </div>
          <div className="chip">
            <span className={ledClass} />
            {linkText}
          </div>
          <button
            type="button"
            className="key primary"
            disabled={dac.busy || dac.filePage || !dac.supported}
            onClick={() => (dac.connected ? dac.disconnect() : dac.connect())}
          >
            {dac.connected ? "断开" : "连接声卡"}
          </button>
          <DeviceDialog firmware={dac.firmware} connected={dac.connected} />
        </div>
      </header>

      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[228px_1fr]">
        <aside className="faceplate flex flex-col gap-3 rounded-2xl p-4">
          <div className="text-center text-[13px] text-slate-500">前级</div>
          <div className="flex items-center justify-center gap-3">
            <div className="flex h-52 flex-col justify-between py-1 text-xs tabular-nums text-slate-500">
              <span>0</span>
              <span>-6</span>
              <span>-12</span>
            </div>
            <Fader
              label="前级"
              min={-12}
              max={0}
              step={1}
              value={dac.preamp}
              height="h-52"
              onChange={(value) => {
                setPreset("");
                dac.setPreamp(value);
              }}
              onEditStart={() => dac.checkpoint("preamp")}
              onEditEnd={dac.endGesture}
            />
          </div>
          <div className="text-center text-sm tabular-nums">
            {dac.preamp > 0 ? "+" : ""}{dac.preamp} dB
          </div>
          <p className="text-center text-[13px] leading-5 text-slate-500">
            高低增益档在机身开关上。这里是数字前级，用来给抬升的频段留余量。
          </p>
          <div className="mt-auto grid grid-cols-2 gap-2">
            <button
              type="button"
              className="key primary col-span-2"
              disabled={!dac.connected || dac.busy}
              onClick={() => setAskWrite(true)}
            >
              写入声卡
            </button>
            <button type="button" className="key" disabled={!dac.connected || dac.busy} onClick={dac.reread}>读取</button>
            <button type="button" className="key" onClick={() => { setPreset(""); dac.matchPreamp(); }}>防止削波</button>
            <button type="button" className="key" disabled={!dac.connected || dac.busy} onClick={() => dac.setEnabled(true)}>均衡开</button>
            <button type="button" className="key" disabled={!dac.connected || dac.busy} onClick={() => dac.setEnabled(false)}>均衡关</button>
            <button type="button" className="key" onClick={() => fileRef.current?.click()}>载入</button>
            <button type="button" className="key" onClick={dac.download}>保存</button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".txt,text/plain"
            className="hidden"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              setPreset("");
              dac.loadText(await file.text());
            }}
          />
        </aside>

        <main className="flex min-h-0 flex-col gap-3">
          <section className="glass flex min-h-[240px] flex-1 flex-col rounded-2xl p-3">
            <div className="mb-2 flex items-center justify-between gap-3 px-1 text-[13px] text-slate-500">
              <span>{hint}</span>
              <div className="flex shrink-0 items-center gap-2">
                <button type="button" className="key" disabled={!dac.canUndo} onClick={() => { setPreset(""); dac.undo(); }}>
                  撤销
                </button>
                {dac.dirty && (
                  <span className="rounded-full border border-sky-700/35 bg-white/40 px-2 py-0.5 text-sky-800">
                    尚未写入声卡
                  </span>
                )}
              </div>
            </div>
            <EqPlot
              bands={dac.bands}
              preamp={dac.preamp}
              selected={dac.selected}
              onSelect={dac.setSelected}
              onGestureStart={() => dac.checkpoint("plot")}
              onGestureEnd={dac.endGesture}
              onEdit={(index, freq, gain) => {
                setPreset("");
                dac.editBand(index, { freq, gain });
              }}
              onQ={(index, q) => {
                setPreset("");
                dac.editBand(index, { q });
              }}
              onReset={(index) => {
                setPreset("");
                dac.checkpoint();
                dac.editBand(index, { gain: 0 });
              }}
              onHover={(text) => setHint(text || hintIdle)}
            />
          </section>

          <section className="faceplate rounded-2xl px-3 py-3">
            <div className="grid grid-cols-5 gap-2 sm:grid-cols-10">
              {dac.bands.map((item, index) => (
                <div
                  key={index}
                  className={`flex cursor-pointer flex-col items-center gap-1 rounded-xl border px-1 py-2 ${
                    index === dac.selected
                      ? "border-sky-600/45 bg-sky-500/10"
                      : "border-transparent"
                  }`}
                  onPointerDown={() => dac.setSelected(index)}
                  onDoubleClick={() => {
                    setPreset("");
                    dac.checkpoint();
                    dac.editBand(index, { gain: 0 });
                  }}
                >
                  <div className="text-[13px] tabular-nums">
                    {item.gain > 0 ? "+" : ""}{item.gain.toFixed(1)}
                  </div>
                  <Fader
                    label={`第 ${index + 1} 段`}
                    min={-12}
                    max={12}
                    step={0.1}
                    value={item.gain}
                    height="h-28"
                    onChange={(gain) => {
                      setPreset("");
                      dac.editBand(index, { gain });
                    }}
                    onEditStart={() => dac.checkpoint(`band-${index}`)}
                    onEditEnd={dac.endGesture}
                  />
                  <div className="text-xs tabular-nums text-slate-500">{formatHz(item.freq)}</div>
                </div>
              ))}
            </div>
          </section>

          <section className="glass flex flex-wrap items-end gap-3 rounded-2xl px-3 py-3">
            <div className="pb-2 text-sm font-semibold">第 {dac.selected + 1} 段</div>
            <label className="text-xs text-slate-500">
              类型
              <select
                className="recess mt-1 block w-24"
                value={band.type}
                onFocus={() => dac.checkpoint("type")}
                onBlur={dac.endGesture}
                onChange={(event) => {
                  setPreset("");
                  dac.editBand(dac.selected, { type: event.target.value as FilterType });
                }}
              >
                {FILTERS.map((type) => (
                  <option key={type} value={type}>{TYPE_LABEL[type]}</option>
                ))}
              </select>
            </label>
            <label className="text-xs text-slate-500">
              频率 Hz
              <input
                className="recess mt-1 block w-24 tabular-nums"
                type="number"
                min={20}
                max={20000}
                step={1}
                value={band.freq}
                onFocus={() => dac.checkpoint("freq")}
                onBlur={dac.endGesture}
                onChange={(event) => {
                  setPreset("");
                  dac.editBand(dac.selected, { freq: Number(event.target.value) });
                }}
              />
            </label>
            <label className="text-xs text-slate-500">
              Q
              <input
                className="recess mt-1 block w-20 tabular-nums"
                type="number"
                min={0.1}
                max={10}
                step={0.01}
                value={Number(band.q.toFixed(2))}
                onFocus={() => dac.checkpoint("q")}
                onBlur={dac.endGesture}
                onChange={(event) => {
                  setPreset("");
                  dac.editBand(dac.selected, { q: Number(event.target.value) });
                }}
              />
            </label>
            <label className="text-xs text-slate-500">
              增益 dB
              <input
                className="recess mt-1 block w-20 tabular-nums"
                type="number"
                min={-12}
                max={12}
                step={0.1}
                value={Number(band.gain.toFixed(1))}
                onFocus={() => dac.checkpoint("gain")}
                onBlur={dac.endGesture}
                onChange={(event) => {
                  setPreset("");
                  dac.editBand(dac.selected, { gain: Number(event.target.value) });
                }}
              />
            </label>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {Object.keys(PRESETS).map((name) => (
                <button
                  key={name}
                  type="button"
                  className="key"
                  data-active={preset === name}
                  onClick={() => {
                    setPreset(name);
                    dac.applyPreset(name);
                  }}
                >
                  {name}
                </button>
              ))}
              {userPresets.length > 0 && <span className="mx-1 h-6 w-px bg-slate-300/80" />}
              {userPresets.map((item) => (
                <button
                  key={item.name}
                  type="button"
                  className="key"
                  data-active={preset === `user:${item.name}`}
                  onClick={() => {
                    setPreset(`user:${item.name}`);
                    dac.replaceCurve(item.preamp, item.bands);
                  }}
                >
                  {item.name}
                </button>
              ))}
              <button
                type="button"
                className="key"
                onClick={() => {
                  setPresetDraft(activeUser);
                  setPresetError("");
                  setAskSave(true);
                }}
              >
                存为预设
              </button>
              {activeUser && (
                <button
                  type="button"
                  className="key"
                  onClick={() => {
                    setUserPresets(removePreset(userPresets, activeUser));
                    setPreset("");
                  }}
                >
                  删除
                </button>
              )}
            </div>
          </section>
        </main>
      </div>

      {dac.notice && (
        <div
          role="status"
          className={`fixed bottom-5 left-1/2 z-20 max-w-[min(520px,calc(100%-2rem))] -translate-x-1/2 rounded-xl border px-4 py-2 text-sm shadow-2xl backdrop-blur-xl ${
            dac.notice.bad
              ? "border-red-300 bg-red-50 text-red-800"
              : "border-white/70 bg-white/55 text-slate-800"
          }`}
        >
          {dac.notice.text}
        </div>
      )}

      <Dialog.Root open={askWrite} onOpenChange={setAskWrite}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-900/20 backdrop-blur-md" />
          <Dialog.Content className="glass fixed left-1/2 top-1/2 z-50 w-[min(420px,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl p-5">
            <Dialog.Title className="text-lg font-semibold">写入 DA5</Dialog.Title>
            <Dialog.Description className="mt-2 text-sm leading-6 text-slate-600">
              这 10 段均衡会保存在声卡里。之后无论接这台电脑还是手机，播放都会经过它。
            </Dialog.Description>
            <div className="mt-5 flex justify-end gap-2">
              <Dialog.Close className="key">取消</Dialog.Close>
              <button
                type="button"
                className="key primary"
                onClick={() => {
                  setAskWrite(false);
                  dac.write();
                }}
              >
                写入
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={dac.incoming !== null} onOpenChange={(open) => { if (!open) dac.keepPage(); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-900/20 backdrop-blur-md" />
          <Dialog.Content className="glass fixed left-1/2 top-1/2 z-50 w-[min(440px,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl p-5">
            <Dialog.Title className="text-lg font-semibold">声卡上是另一套均衡</Dialog.Title>
            <Dialog.Description className="mt-2 text-sm leading-6 text-slate-600">
              页面上的修改还没写入。可以留在页面上，之后再点写入；也可以丢掉这些修改，改用声卡里现在的曲线。
              页面前级 {dac.preamp} dB，声卡前级 {dac.incoming?.preamp ?? 0} dB。
            </Dialog.Description>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className="key" onClick={dac.keepPage}>留在页面上</button>
              <button
                type="button"
                className="key primary"
                onClick={() => {
                  setPreset("");
                  dac.useDevice();
                }}
              >
                用声卡里的
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={askSave} onOpenChange={setAskSave}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-900/20 backdrop-blur-md" />
          <Dialog.Content className="glass fixed left-1/2 top-1/2 z-50 w-[min(420px,calc(100%-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl p-5">
            <Dialog.Title className="text-lg font-semibold">存为预设</Dialog.Title>
            <Dialog.Description className="mt-2 text-sm leading-6 text-slate-600">
              名字存在这台电脑的浏览器里。点预设只改页面，要进声卡仍需写入。
            </Dialog.Description>
            <form
              className="mt-4"
              onSubmit={(event) => {
                event.preventDefault();
                saveUserPreset();
              }}
            >
              <input
                className="recess w-full"
                autoFocus
                maxLength={16}
                placeholder="例如 通勤"
                value={presetDraft}
                onChange={(event) => {
                  setPresetDraft(event.target.value);
                  setPresetError("");
                }}
              />
              {presetError && <p className="mt-2 text-sm text-red-700">{presetError}</p>}
              <div className="mt-5 flex justify-end gap-2">
                <Dialog.Close className="key">取消</Dialog.Close>
                <button type="submit" className="key primary">
                  {userPresets.some((item) => item.name === presetName(presetDraft)) ? "覆盖" : "保存"}
                </button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
