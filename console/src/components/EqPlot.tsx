import { useEffect, useRef, useState } from "react";
import { qFromDrag } from "../hid/edits";
import { type Band, curveOf, responseAt } from "../hid/protocol";

interface EqPlotProps {
  bands: Band[];
  preamp: number;
  selected: number;
  onSelect: (index: number) => void;
  onEdit: (index: number, freq: number, gain: number) => void;
  onQ: (index: number, q: number) => void;
  onReset: (index: number) => void;
  onHover: (text: string | null) => void;
  onGestureStart: () => void;
  onGestureEnd: () => void;
}

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function plotBox(width: number, height: number): Box {
  return {
    left: 46,
    right: Math.max(80, width - 16),
    top: 16,
    bottom: Math.max(48, height - 26),
  };
}

function xOf(freq: number, box: Box) {
  const span = box.right - box.left;
  return box.left + span * (Math.log(freq / 20) / Math.log(1000));
}

function yOf(db: number, box: Box) {
  const span = box.bottom - box.top;
  return box.top + span * ((12 - db) / 24);
}

function freqOf(x: number, box: Box) {
  const t = (x - box.left) / (box.right - box.left);
  return 20 * 1000 ** Math.min(1, Math.max(0, t));
}

function dbOf(y: number, box: Box) {
  const t = (y - box.top) / (box.bottom - box.top);
  return 12 - 24 * Math.min(1, Math.max(0, t));
}

export function EqPlot({
  bands,
  preamp,
  selected,
  onSelect,
  onEdit,
  onQ,
  onReset,
  onHover,
  onGestureStart,
  onGestureEnd,
}: EqPlotProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragIndex = useRef(-1);
  const dragQ = useRef(false);
  const qOrigin = useRef({ q: 1, y: 0 });
  const [frame, setFrame] = useState(0);
  const [qDrag, setQDrag] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    const box = plotBox(rect.width, rect.height);
    ctx.font = "12px Microsoft YaHei UI, PingFang SC, Segoe UI, sans-serif";
    ctx.textBaseline = "middle";

    for (const db of [-12, -6, 0, 6, 12]) {
      const y = yOf(db, box);
      ctx.strokeStyle = db === 0 ? "rgba(37, 99, 168, 0.45)" : "rgba(40, 70, 110, 0.12)";
      ctx.beginPath();
      ctx.moveTo(box.left, y);
      ctx.lineTo(box.right, y);
      ctx.stroke();
      ctx.fillStyle = "#475569";
      ctx.textAlign = "right";
      ctx.fillText(String(db), box.left - 8, y);
    }
    for (const freq of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
      const x = xOf(freq, box);
      ctx.strokeStyle = "rgba(40, 70, 110, 0.1)";
      ctx.beginPath();
      ctx.moveTo(x, box.top);
      ctx.lineTo(x, box.bottom);
      ctx.stroke();
      ctx.fillStyle = "#475569";
      ctx.textAlign = "center";
      ctx.fillText(freq >= 1000 ? `${freq / 1000}k` : String(freq), x, box.bottom + 14);
    }

    const current = bands[selected];
    if (current && Math.abs(current.gain) >= 0.05) {
      ctx.beginPath();
      for (let i = 0; i <= 120; i += 1) {
        const freq = 20 * 1000 ** (i / 120);
        const db = Math.max(-12, Math.min(12, responseAt(freq, current)));
        const x = xOf(freq, box);
        const y = yOf(db, box);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = "rgba(40, 70, 110, 0.4)";
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    const curve = curveOf(bands, preamp);
    const point = (freq: number, db: number) => [xOf(freq, box), yOf(Math.max(-12, Math.min(12, db)), box)] as const;
    ctx.beginPath();
    curve.forEach(([freq, db], index) => {
      const [x, y] = point(freq, db);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.lineTo(xOf(curve[curve.length - 1][0], box), yOf(0, box));
    ctx.lineTo(xOf(curve[0][0], box), yOf(0, box));
    ctx.closePath();
    ctx.fillStyle = "rgba(37, 120, 196, 0.16)";
    ctx.fill();
    ctx.beginPath();
    curve.forEach(([freq, db], index) => {
      const [x, y] = point(freq, db);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = "#1d6fbf";
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.stroke();

    bands.forEach((band, index) => {
      const x = xOf(band.freq, box);
      const y = yOf(band.gain, box);
      const active = index === selected;
      ctx.beginPath();
      ctx.arc(x, y, active ? 8 : 5.5, 0, Math.PI * 2);
      ctx.fillStyle = active ? "#bfdbfe" : "#ffffff";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#1d6fbf";
      ctx.stroke();
      if (active) {
        ctx.fillStyle = "#1e293b";
        ctx.textAlign = "center";
        const label = qDrag
          ? `Q ${band.q.toFixed(2)}`
          : `${band.gain > 0 ? "+" : ""}${band.gain.toFixed(1)}`;
        ctx.fillText(label, x, y - 16);
      }
    });
  }, [bands, frame, preamp, qDrag, selected]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => setFrame((value) => value + 1));
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  function localPoint(event: { clientX: number; clientY: number; currentTarget: HTMLCanvasElement }) {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      box: plotBox(rect.width, rect.height),
    };
  }

  function nodeAt(x: number, y: number, box: Box) {
    let best = -1;
    let bestDist = 18;
    bands.forEach((band, index) => {
      const dist = Math.hypot(xOf(band.freq, box) - x, yOf(band.gain, box) - y);
      if (dist < bestDist) {
        best = index;
        bestDist = dist;
      }
    });
    return best;
  }

  function responseDb(freq: number) {
    let db = preamp;
    for (const band of bands) {
      if ((band.type === "PK" || band.type === "LSQ" || band.type === "HSQ") && Math.abs(band.gain) < 0.05) continue;
      db += responseAt(freq, band);
    }
    return db;
  }

  return (
    <canvas
      ref={canvasRef}
      className="h-full min-h-[220px] w-full touch-none"
      onPointerDown={(event) => {
        const { x, y, box } = localPoint(event);
        const index = nodeAt(x, y, box);
        if (index < 0) return;
        dragIndex.current = index;
        dragQ.current = event.shiftKey;
        qOrigin.current = { q: bands[index].q, y };
        setQDrag(event.shiftKey);
        onGestureStart();
        onSelect(index);
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // Synthetic pointer events cannot be captured.
        }
      }}
      onPointerMove={(event) => {
        const { x, y, box } = localPoint(event);
        if (dragIndex.current >= 0 && dragQ.current) {
          const next = qFromDrag(qOrigin.current.q, qOrigin.current.y - y);
          onHover(`Q ${next.toFixed(2)}`);
          onQ(dragIndex.current, next);
          return;
        }
        const freq = freqOf(x, box);
        const db = responseDb(freq);
        const note = event.shiftKey ? " · 按住 Shift 拖动改 Q" : "";
        onHover(`${Math.round(freq)} Hz · 总响应 ${db.toFixed(1)} dB${note}`);
        if (dragIndex.current < 0) return;
        onEdit(dragIndex.current, freq, dbOf(y, box));
      }}
      onPointerUp={() => {
        dragIndex.current = -1;
        dragQ.current = false;
        setQDrag(false);
        onGestureEnd();
      }}
      onPointerCancel={() => {
        dragIndex.current = -1;
        dragQ.current = false;
        setQDrag(false);
        onGestureEnd();
      }}
      onPointerLeave={() => {
        if (dragIndex.current >= 0) return;
        onHover(null);
      }}
      onDoubleClick={(event) => {
        const { x, y, box } = localPoint(event);
        const index = nodeAt(x, y, box);
        if (index < 0) return;
        onReset(index);
      }}
    />
  );
}
