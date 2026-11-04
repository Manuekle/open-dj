"use client";

import { memo, useId } from "react";
import { SegmentedControl, SegmentedControlItem } from "@/components/sodium/ui/segmented-control";
import { Switch } from "@/components/sodium/ui/switch";
import { Pick } from "@/components/pick";
import { DURATIONS, ENERGY, STYLES, TEMPO, durationValue, type EnergyFlow, type SmartStyle, type TempoMatch } from "./model";

const UNWIRED = "Not available yet: the engine does not read this setting.";

type Props = {
  /** The planner's override, or null while the engine does not expose one. */
  style: SmartStyle | null;
  onStyle: ((patch: Partial<SmartStyle>) => void) | null;
  smart: boolean; loop: boolean;
  onSmart: (on: boolean) => void; onLoop: (on: boolean) => void;
};

/** One setting: its name in the label column, the control, and a caption when it needs one. */
function Row({ label, id, caption, children }: { label: string; id: string; caption?: string; children: React.ReactNode }) {
  return <div className="rule-row flex items-start gap-3 py-1.5">
    <span id={id} className="flex h-(--control-sm) w-24 shrink-0 items-center type-label-sm text-text-2">{label}</span>
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      {children}
      {caption && <p className="type-caption text-text-2">{caption}</p>}
    </div>
  </div>;
}

/* AutoMix's settings. Each control writes straight to the engine (the planner's style, the queue's order and loop), so it
   applies to the next transition as soon as it changes. A setting the engine does not read yet stays visible, disabled,
   and says so, so nothing on the panel pretends to work. */
export const AutoMixSettings = memo(function AutoMixSettings({ style, onStyle, smart, loop, onSmart, onLoop }: Props) {
  const id = useId();
  const styleOn = !!style && !!onStyle;
  const set = (patch: Partial<SmartStyle>) => { if (onStyle) onStyle(patch); };

  return <section aria-label="AutoMix settings" className="flex min-w-0 flex-col">
    <div className="flex h-(--control) items-center border-b border-line-faint"><h3 className="type-label-sm text-text-2">Settings</h3></div>
    <Row label="Style" id={`${id}-style`} caption={styleOn ? undefined : UNWIRED}>
      <Pick aria-label="Transition style" items={STYLES} value={style?.strategy ?? "auto"} disabled={!styleOn} onValueChange={v => set({ strategy: v as SmartStyle["strategy"] })} className="w-full"/>
    </Row>
    <Row label="Beats" id={`${id}-beats`} caption={styleOn ? undefined : UNWIRED}>
      <SegmentedControl fill size="sm" aria-labelledby={`${id}-beats`} value={durationValue(style?.bars ?? "auto")} disabled={!styleOn}
        onValueChange={v => set({ bars: DURATIONS.find(d => d.value === v)?.bars ?? "auto" })}>
        {DURATIONS.map(d => <SegmentedControlItem key={d.value} value={d.value} aria-label={d.value === "auto" ? "Auto length" : `${d.label} beats`}>{d.label}</SegmentedControlItem>)}
      </SegmentedControl>
    </Row>
    <Row label="Tempo match" id={`${id}-tempo`} caption={styleOn ? (style.tempo === "off" ? "The incoming track keeps its own tempo: only Quick cut and Smart fallback can play." : style.tempo === "gentle" ? "Synced transitions stretch the incoming track by at most 4%." : undefined) : UNWIRED}>
      <SegmentedControl fill size="sm" aria-labelledby={`${id}-tempo`} value={style?.tempo ?? "standard"} disabled={!styleOn} onValueChange={v => set({ tempo: v as TempoMatch })}>
        {TEMPO.map(o => <SegmentedControlItem key={o.value} value={o.value}>{o.label}</SegmentedControlItem>)}
      </SegmentedControl>
    </Row>
    <Row label="Energy flow" id={`${id}-energy`} caption={styleOn ? (style.energy === "auto" ? "Each style aims for its own energy." : undefined) : UNWIRED}>
      <SegmentedControl fill size="sm" aria-labelledby={`${id}-energy`} value={style?.energy ?? "auto"} disabled={!styleOn} onValueChange={v => set({ energy: v as EnergyFlow })}>
        {ENERGY.map(o => <SegmentedControlItem key={o.value} value={o.value}>{o.label}</SegmentedControlItem>)}
      </SegmentedControl>
    </Row>
    <Row label="Order" id={`${id}-order`} caption={smart ? "Sorts what follows by tempo, key and energy." : undefined}>
      <SegmentedControl fill size="sm" aria-labelledby={`${id}-order`} value={smart ? "smart" : "original"} onValueChange={v => onSmart(v === "smart")}>
        <SegmentedControlItem value="original">Original</SegmentedControlItem>
        <SegmentedControlItem value="smart">Smart</SegmentedControlItem>
      </SegmentedControl>
    </Row>
    <Row label="Loop" id={`${id}-loop`} caption={loop ? "The queue starts over after its last track." : "The set ends after the last track."}>
      <Switch size="sm" aria-labelledby={`${id}-loop`} checked={loop} onCheckedChange={onLoop}/>
    </Row>
  </section>;
});
