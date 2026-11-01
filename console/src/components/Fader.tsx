import * as Slider from "@radix-ui/react-slider";
import { cn } from "../lib/utils";

interface FaderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  height?: string;
  onChange: (value: number) => void;
  onEditStart?: () => void;
  onEditEnd?: () => void;
}

export function Fader({ label, value, min, max, step, height = "h-44", onChange, onEditStart, onEditEnd }: FaderProps) {
  return (
    <Slider.Root
      orientation="vertical"
      min={min}
      max={max}
      step={step}
      value={[value]}
      onPointerDown={() => onEditStart?.()}
      onPointerUp={() => onEditEnd?.()}
      onPointerCancel={() => onEditEnd?.()}
      onKeyDown={(event) => {
        if (event.repeat || !event.key.startsWith("Arrow")) return;
        onEditStart?.();
      }}
      onKeyUp={() => onEditEnd?.()}
      onValueChange={([next]) => onChange(next)}
      aria-label={label}
      className={cn("relative flex w-9 touch-none select-none items-center justify-center", height)}
    >
      <Slider.Track className="groove relative w-[7px] grow rounded-full">
        <Slider.Range className="absolute w-full rounded-full bg-gradient-to-t from-sky-800/90 to-sky-200" />
      </Slider.Track>
      <Slider.Thumb className="block h-6 w-8 cursor-ns-resize rounded-[4px] border border-slate-300 bg-gradient-to-b from-white via-slate-100 to-slate-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.95),0_1px_2px_rgba(40,60,90,0.28)] outline-none focus-visible:ring-2 focus-visible:ring-sky-600/70" />
    </Slider.Root>
  );
}
