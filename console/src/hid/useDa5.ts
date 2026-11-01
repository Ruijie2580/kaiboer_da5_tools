import { useCallback, useEffect, useRef, useState } from "react";
import { Da5Link } from "./link";
import { shouldAsk } from "./edits";
import {
  type Band,
  DEFAULT_FREQS,
  DEFAULT_Q,
  PRESETS,
  clampBand,
  clampPreamp,
  flatBands,
  loadProfileText,
  saveProfileText,
  snapshot,
} from "./protocol";

export interface DeviceCurve {
  firmware: string;
  preamp: number;
  bands: Band[];
  name?: string;
}

export interface Notice {
  text: string;
  bad: boolean;
}

const initialBands = flatBands();
const initialSnap = snapshot(0, initialBands);

export function useDa5() {
  const [link] = useState(() => new Da5Link());
  const [connected, setConnected] = useState(false);
  const [firmware, setFirmware] = useState("");
  const [preamp, setPreampState] = useState(0);
  const [bands, setBands] = useState<Band[]>(initialBands);
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [clean, setClean] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [incoming, setIncoming] = useState<DeviceCurve | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const busyRef = useRef(false);
  const toastTimer = useRef(0);
  const pastRef = useRef<string[]>([]);
  const gestureRef = useRef<string | null>(null);
  const incomingRef = useRef<DeviceCurve | null>(null);
  const preampRef = useRef(preamp);
  const bandsRef = useRef(bands);
  preampRef.current = preamp;
  bandsRef.current = bands;
  const dirty = snapshot(preamp, bands) !== (clean || initialSnap);
  const pageRef = useRef({ preamp, bands, dirty });
  pageRef.current = { preamp, bands, dirty };

  const supported = typeof navigator !== "undefined" && "hid" in navigator;
  const filePage = typeof location !== "undefined" && location.protocol === "file:";

  const toast = useCallback((text: string, bad = false) => {
    setNotice({ text, bad });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setNotice(null), 4200);
  }, []);

  const checkpoint = useCallback((gesture?: string) => {
    if (gesture && gestureRef.current === gesture) return;
    gestureRef.current = gesture ?? null;
    const snap = snapshot(preampRef.current, bandsRef.current);
    const past = pastRef.current;
    if (past[past.length - 1] === snap) return;
    past.push(snap);
    if (past.length > 40) past.shift();
    setCanUndo(true);
  }, []);

  const endGesture = useCallback(() => {
    gestureRef.current = null;
  }, []);

  const undo = useCallback(() => {
    const prev = pastRef.current.pop();
    gestureRef.current = null;
    setCanUndo(pastRef.current.length > 0);
    if (!prev) return;
    const data = JSON.parse(prev) as { preamp: number; bands: Band[] };
    setPreampState(clampPreamp(data.preamp));
    setBands(data.bands.map(clampBand));
  }, []);

  const applyRead = useCallback((next: DeviceCurve) => {
    incomingRef.current = null;
    setIncoming(null);
    setFirmware(next.firmware);
    setPreampState(clampPreamp(next.preamp));
    setBands(next.bands.map(clampBand));
    setClean(snapshot(clampPreamp(next.preamp), next.bands));
    setConnected(true);
  }, []);

  const consider = useCallback((data: DeviceCurve, doneText: string) => {
    setFirmware(data.firmware);
    setConnected(true);
    const page = pageRef.current;
    const deviceSnap = snapshot(clampPreamp(data.preamp), data.bands);
    const pageSnap = snapshot(page.preamp, page.bands);
    if (shouldAsk(page.dirty, pageSnap, deviceSnap)) {
      incomingRef.current = data;
      setIncoming(data);
      return;
    }
    applyRead(data);
    toast(doneText);
  }, [applyRead, toast]);

  const keepPage = useCallback(() => {
    if (!incomingRef.current) return;
    incomingRef.current = null;
    setIncoming(null);
    toast("已连接。页面上的修改还没写入。");
  }, [toast]);

  const useDevice = useCallback(() => {
    const data = incomingRef.current;
    if (!data) return;
    incomingRef.current = null;
    setIncoming(null);
    checkpoint();
    applyRead(data);
    toast("已改用声卡里的均衡");
  }, [applyRead, checkpoint, toast]);

  const run = useCallback(async (label: string, action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setStatus(label);
    try {
      await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast(message, true);
    } finally {
      busyRef.current = false;
      setBusy(false);
      setStatus("");
    }
  }, [toast]);

  const connect = useCallback(() => run("正在连接…", async () => {
    try {
      const ok = await link.requestDevice();
      if (!ok) return;
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotAllowedError") return;
      throw error;
    }
    const data = await link.readAll();
    consider(data, `已连接 ${data.name}，固件 ${data.firmware}`);
  }), [consider, link, run]);

  const disconnect = useCallback(() => {
    link.close();
    setConnected(false);
    setFirmware("");
  }, [link]);

  const reread = useCallback(() => run("正在读取…", async () => {
    const data = await link.readAll();
    consider(data, "已从声卡读回当前均衡");
  }), [consider, link, run]);

  const write = useCallback(() => run("正在写入…", async () => {
    incomingRef.current = null;
    setIncoming(null);
    const expectedBands = bands.map(clampBand);
    const expectedPreamp = clampPreamp(preamp);
    setPreampState(expectedPreamp);
    await link.writeProfile(expectedBands, expectedPreamp);
    const nextBands = await link.readBands();
    const nextPreamp = clampPreamp(await link.readPreamp());
    setBands(nextBands);
    setPreampState(nextPreamp);
    setClean(snapshot(nextPreamp, nextBands));
    const mismatch: string[] = [];
    if (nextPreamp !== expectedPreamp) mismatch.push(`前级读回 ${nextPreamp} dB`);
    nextBands.forEach((band, index) => {
      const want = expectedBands[index];
      const same = band.type === want.type
        && band.freq === want.freq
        && Math.abs(band.gain - want.gain) <= 0.05
        && Math.abs(band.q - want.q) <= 0.02;
      if (!same) mismatch.push(`第 ${index + 1} 段读回 ${band.gain.toFixed(1)} dB`);
    });
    if (mismatch.length) toast(`已写入，但读回不一致：${mismatch.slice(0, 3).join("，")}`, true);
    else toast("已写入 DA5，并从声卡读回");
  }), [bands, link, preamp, run, toast]);

  const setEnabled = useCallback((enabled: boolean) => run(
    enabled ? "正在打开均衡…" : "正在关闭均衡…",
    async () => {
      await link.setEnabled(enabled);
      toast(enabled ? "硬件均衡已打开" : "硬件均衡已关闭，曲线仍留在声卡里");
    },
  ), [link, run, toast]);

  const setPreamp = useCallback((value: number) => {
    setPreampState(clampPreamp(value));
  }, []);

  const editBand = useCallback((index: number, patch: Partial<Band>) => {
    setSelected(index);
    setBands((current) => current.map((band, at) => (
      at === index ? clampBand({ ...band, ...patch }) : band
    )));
  }, []);

  const replaceCurve = useCallback((nextPreamp: number, nextBands: Band[]) => {
    const preampValue = clampPreamp(nextPreamp);
    const nextBandsValue = nextBands.map(clampBand);
    const nextSnap = snapshot(preampValue, nextBandsValue);
    const currentSnap = snapshot(preampRef.current, bandsRef.current);
    if (nextSnap === currentSnap) return;
    checkpoint();
    setPreampState(preampValue);
    setBands(nextBandsValue);
  }, [checkpoint]);

  const applyPreset = useCallback((preset: string) => {
    const gains = PRESETS[preset];
    if (!gains) return;
    const peak = Math.max(...gains);
    replaceCurve(peak > 0 ? -Math.ceil(peak) : 0, gains.map((gain, index) => ({
      type: "PK",
      freq: DEFAULT_FREQS[index],
      gain,
      q: DEFAULT_Q,
    })));
    setSelected(0);
  }, [replaceCurve]);

  const matchPreamp = useCallback(() => {
    const peak = Math.max(...bandsRef.current.map((band) => band.gain));
    const next = peak > 0 ? -Math.ceil(peak) : 0;
    if (next === clampPreamp(preampRef.current)) return;
    checkpoint();
    setPreampState(next);
  }, [checkpoint]);

  const loadText = useCallback((text: string) => {
    try {
      const loaded = loadProfileText(text);
      replaceCurve(loaded.preamp, loaded.bands);
      toast("已载入文件。还没有写进声卡。");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), true);
    }
  }, [replaceCurve, toast]);

  const download = useCallback(() => {
    const blob = new Blob([saveProfileText(preamp, bands)], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "da5-eq.txt";
    anchor.click();
    URL.revokeObjectURL(url);
  }, [bands, preamp]);

  useEffect(() => {
    if (!supported || filePage) return;
    const onDisconnect = (event: HIDConnectionEvent) => {
      link.dropped(event.device);
      setConnected(false);
      setFirmware("");
      toast("DA5 已拔出", true);
    };
    navigator.hid.addEventListener("disconnect", onDisconnect);
    link.reconnect().then(async (found) => {
      if (!found) return;
      const data = await link.readAll();
      consider(data, `已连接 ${data.name}，固件 ${data.firmware}`);
    }).catch((error: unknown) => {
      toast(error instanceof Error ? error.message : String(error), true);
    });
    return () => navigator.hid.removeEventListener("disconnect", onDisconnect);
  }, [consider, filePage, link, supported, toast]);

  return {
    supported,
    filePage,
    connected,
    busy,
    firmware,
    preamp,
    bands,
    selected,
    dirty,
    status,
    notice,
    incoming,
    canUndo,
    connect,
    disconnect,
    reread,
    write,
    setEnabled,
    setPreamp,
    setSelected,
    editBand,
    applyPreset,
    replaceCurve,
    matchPreamp,
    loadText,
    download,
    checkpoint,
    endGesture,
    undo,
    keepPage,
    useDevice,
  };
}
