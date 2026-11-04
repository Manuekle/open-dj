"use client";

import { memo, useId } from "react";
import { SegmentedControl, SegmentedControlItem } from "@/components/sodium/ui/segmented-control";
import { Switch } from "@/components/sodium/ui/switch";
import { Pick } from "@/components/pick";
import { Slider } from "@/components/sodium/ui/slider";
import { Button } from "@/components/sodium/ui/button";
import { labelOf, EFFECT_OPTIONS, EQ_OPTIONS, STEM_OPTIONS, VOLUME_OPTIONS } from "@/lib/transition-options";
import { AUTO_EFFECT, AUTO_EQ, AUTO_STEMS, AUTO_VOLUME, DURATIONS, ENERGY, STYLES, TEMPO, durationValue, type EnergyFlow, type SmartStyle, type TempoMatch } from "./model";

const UNWIRED = "Not available yet: the engine does not read this setting.";

type Props = {
  /** The planner's override, or null while the engine does not expose one. */
  style: SmartStyle | null;
  onStyle: ((patch: Partial<SmartStyle>) => void) | null;
  smart: boolean; loop: boolean;
  onSmart: (on: boolean) => void; onLoop: (on: boolean) => void;
  /** Whether the local AI model and Demucs answer (null until asked), and what they are working on now. */
  services: ServicesView;
};
export type ServicesView = { ai: boolean | null; stems: boolean | null; planning: string | null; splitting: string | null };

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
export const AutoMixSettings = memo(function AutoMixSettings({ style, onStyle, smart, loop, onSmart, onLoop, services }: Props) {
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
    <Row label="AI plans" id={`${id}-ai`} caption={services.ai === false ? "Needs Ollama running on this machine with the model pulled (see /api/mix)."
      : style?.ai ? (services.planning ? `Planning ${services.planning}…` : "The local model plans each pair before it plays; a plan you edited is kept. Too late an answer leaves the planner's plan.")
      : "The planner's rules plan every transition."}>
      <Switch size="sm" aria-labelledby={`${id}-ai`} checked={!!style?.ai} disabled={!styleOn || (services.ai === false && !style?.ai)} onCheckedChange={on => set({ ai: on })}/>
    </Row>
    <Row label="Auto stems" id={`${id}-stems-auto`} caption={services.stems === false ? "Needs Demucs on this machine: run npm run setup:stems."
      : style?.autoStems ? (services.splitting ? `Splitting ${services.splitting}` : "Demucs splits the next tracks in the queue, so stem moves can play.")
      : "Only tracks you split by hand have stems."}>
      <Switch size="sm" aria-labelledby={`${id}-stems-auto`} checked={!!style?.autoStems} disabled={!styleOn || (services.stems === false && !style?.autoStems)} onCheckedChange={on => set({ autoStems: on })}/>
    </Row>
    {style?.template && <Row label="Template" id={`${id}-template`} caption="Saved from the transition editor. The overrides below still win where set.">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate type-body-sm">{[labelOf(VOLUME_OPTIONS, style.template.volume), labelOf(EQ_OPTIONS, style.template.eq), labelOf(EFFECT_OPTIONS, style.template.effect),
          style.template.stems && style.template.stems !== "none" ? labelOf(STEM_OPTIONS, style.template.stems) : null].filter(Boolean).join(" · ")}</span>
        <Button size="sm" variant="ghost" onClick={() => set({ template: null })}>Clear</Button>
      </div>
    </Row>}
    <Row label="Curve" id={`${id}-curve`} caption={styleOn ? undefined : UNWIRED}>
      <Pick aria-label="Volume curve for every transition" items={AUTO_VOLUME} value={style?.volume ?? "auto"} disabled={!styleOn} onValueChange={v => set({ volume: v as SmartStyle["volume"] })} className="w-full"/>
    </Row>
    <Row label="Low end" id={`${id}-eq`} caption={styleOn ? undefined : UNWIRED}>
      <SegmentedControl fill size="sm" aria-labelledby={`${id}-eq`} value={style?.eq ?? "auto"} disabled={!styleOn} onValueChange={v => set({ eq: v as SmartStyle["eq"] })}>
        {AUTO_EQ.map(o => <SegmentedControlItem key={o.value} value={o.value}>{o.label}</SegmentedControlItem>)}
      </SegmentedControl>
    </Row>
    <Row label="Effect" id={`${id}-effect`} caption={styleOn ? undefined : UNWIRED}>
      <Pick aria-label="Effect for every transition" items={AUTO_EFFECT} value={style?.effect ?? "auto"} disabled={!styleOn} onValueChange={v => set({ effect: v as SmartStyle["effect"] })} className="w-full"/>
    </Row>
    <Row label="Intensity" id={`${id}-intensity`} caption={styleOn ? undefined : UNWIRED}>
      <Slider min={0} max={150} value={Math.round((style?.intensity ?? 1) * 100)} disabled={!styleOn} aria-labelledby={`${id}-intensity`}
        format={{ style: "unit", unit: "percent" }} showValue onValueChange={v => set({ intensity: (Array.isArray(v) ? v[0] : v as number) / 100 })}/>
    </Row>
    <Row label="Stems" id={`${id}-stems`} caption={styleOn ? (style.stems && style.stems !== "auto" && style.stems !== "none" ? "Applies to pairs where both tracks have stems; others swap the bass on the eq." : undefined) : UNWIRED}>
      <Pick aria-label="Stem move for every transition" items={AUTO_STEMS} value={style?.stems ?? "auto"} disabled={!styleOn} onValueChange={v => set({ stems: v as SmartStyle["stems"] })} className="w-full"/>
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
