"use client";

import { memo, useMemo } from "react";
import type { DeckId, Track, TransitionState } from "@/lib/types";
import { Frame, FrameActions, FrameBody, FrameFooter, FrameHeader, FrameMeta, FrameStatus, FrameTitle } from "@/components/sodium/ui/frame";
import { StatusStrip, StatusStripCell, StatusStripLabel, StatusStripUnit, StatusStripValue } from "@/components/sodium/ui/status-strip";
import { Status } from "@/components/sodium/ui/status";
import { Meter, MeterLabel, MeterValue } from "@/components/sodium/ui/meter";
import { Progress, ProgressLabel, ProgressValue } from "@/components/sodium/ui/progress";
import { Button } from "@/components/sodium/ui/button";
import { Switch } from "@/components/sodium/ui/switch";
import { Field, FieldLabel } from "@/components/sodium/ui/field";
import { Hint } from "@/components/hint";
import { IconSwap, TextSwap } from "@/components/motion";
import { Icon, Next, Pause, Play } from "@/components/sodium/icon";
import { Countdown } from "./countdown";
import { MixCurves } from "./mix-curves";
import { QueueList } from "./queue-list";
import { AutoMixSettings, type ServicesView } from "./settings";
import {
  HARMONY_SHORT, PHASE, confidenceWord, formatGap, pairView, phaseOf, queueRows,
  type AutoControls, type AutoView, type DeckLite, type QueueActions, type ScoreView, type SmartStyle,
} from "./model";

export type AutoMixPanelProps = {
  auto: AutoView;
  controls: AutoControls;
  queue: QueueActions;
  /** Every track the engine knows, to name queue entries and the pair. */
  tracks: Track[];
  /** The open project's tracks, which "Queue library" adds. */
  library: Track[];
  decks: Record<DeckId, DeckLite>;
  live: DeckId;
  transition: TransitionState | null;
  /** Stable: read every frame by the countdown. */
  mediaTime: (id: DeckId) => number;
  score: ScoreView | null;
  /** Why the planner could not use the forced style, when it could not. */
  fallback: string | null;
  style: SmartStyle | null;
  onStyle: ((patch: Partial<SmartStyle>) => void) | null;
  services: ServicesView;
};

const deckWord = (id: DeckId | null) => id ? `Deck ${id === "A" ? 1 : 2}` : "Not loaded";
const pct = (v: number | null | undefined) => v === null || v === undefined ? "-" : `${Math.round(v * 100)}%`;

/* Smart AutoMix as one region beside the console: its state and the next transition on a ruled strip, the planner's
   score and the curves it will play, then the queue and the settings. It renders from the engine's snapshot and the
   planner's rating only; it is memoized on them, so the ten-times-a-second deck clock does not re-render it, and the
   countdown and the progress line are the only parts that move during playback. */
export const AutoMixPanel = memo(function AutoMixPanel(p: AutoMixPanelProps) {
  const { auto, controls, queue, decks, live, transition, score } = p;
  const byId = useMemo(() => new Map(p.tracks.map(t => [t.id, t])), [p.tracks]);
  const plan = transition?.plan ?? auto.plan;
  const pair = useMemo(() => pairView(plan, byId, decks, live, auto.nextTrackId), [plan, byId, decks, live, auto.nextTrackId]);
  const rows = useMemo(() => queueRows(auto.queue, byId, auto.nextUid), [auto.queue, byId, auto.nextUid]);
  const unqueued = useMemo(() => {
    const queued = new Set(auto.queue.items.map(i => i.trackId));
    return p.library.filter(t => !queued.has(t.id)).map(t => t.id);
  }, [p.library, auto.queue.items]);

  const phase = phaseOf(auto);
  // "analyzing" with nothing to analyze is AutoMix waiting at the end of the queue, not working: say that.
  const waiting = phase === "analyzing" && !auto.nextTrackId && !transition;
  const shown = waiting ? { status: "idle" as const, label: "Queue ended" } : PHASE[phase];
  const mixing = !!transition;
  const fromDeck = pair.from?.deck ?? null;
  const anyPlaying = decks.A.playing || decks.B.playing;
  // The switch only says whether AutoMix follows the decks; playing the queue is its own button, so turning AutoMix on
  // never starts a track by surprise, and starting the set is always one obvious press.
  const toggle = (on: boolean) => { if (!on) controls.stop(); else controls.enable(); };
  const canStart = !anyPlaying && !mixing && auto.queue.items.some(i => i.status !== "failed");
  const value = score?.score ?? plan?.score ?? null;
  const detail = auto.error ?? auto.detail;

  return <Frame aria-label="AutoMix" id="automix">
    <FrameHeader>
      <FrameTitle>AutoMix</FrameTitle>
      <FrameStatus><Status size="sm" status={shown.status} live><TextSwap>{shown.label}</TextSwap></Status></FrameStatus>
      <FrameActions>
        {!anyPlaying && <Hint label={canStart ? "Turn AutoMix on and play the queue from its next track" : "Add tracks to the queue first"}>
          <Button size="sm" disabled={!canStart} onClick={controls.start}><Icon icon={Play}/>Play queue</Button>
        </Hint>}
        <Hint label={auto.phase === "paused" ? "Resume AutoMix" : "Pause AutoMix: the decks keep playing, no mix starts"}>
          <Button size="icon-sm" variant="ghost" disabled={!auto.enabled || auto.pausing} aria-pressed={auto.phase === "paused"}
            onClick={auto.phase === "paused" ? controls.resume : controls.pause} aria-label={auto.phase === "paused" ? "Resume AutoMix" : "Pause AutoMix"}>
            <IconSwap active={auto.phase !== "paused"} from={Play} to={Pause}/>
          </Button>
        </Hint>
        <Hint label="Skip the next track">
          <Button size="icon-sm" variant="ghost" disabled={!auto.enabled || mixing || auto.skipPending || !auto.nextTrackId}
            onClick={controls.skip} aria-label="Skip the next track"><Icon icon={Next}/></Button>
        </Hint>
      </FrameActions>
    </FrameHeader>

    <FrameBody padding="none">
      <StatusStrip variant="plain" label="Next transition">
        <StatusStripCell>
          <StatusStripLabel>Now</StatusStripLabel>
          <StatusStripValue className="min-w-0"><span className="truncate" title={pair.from?.track.title}>{pair.from?.track.title ?? "-"}</span><StatusStripUnit>{deckWord(fromDeck)}</StatusStripUnit></StatusStripValue>
        </StatusStripCell>
        <StatusStripCell>
          <StatusStripLabel>Next</StatusStripLabel>
          <StatusStripValue className="min-w-0"><span className="truncate" title={pair.to?.track.title}>{pair.to?.track.title ?? "-"}</span>
            <StatusStripUnit>{pair.to?.deck ? deckWord(pair.to.deck) : auto.nextSource === "queue" ? "Queued" : ""}</StatusStripUnit></StatusStripValue>
        </StatusStripCell>
        <StatusStripCell>
          <StatusStripLabel>Tempo</StatusStripLabel>
          <StatusStripValue>{pair.from?.bpm ? pair.from.bpm.toFixed(1) : "-"} / {pair.to?.bpm ? pair.to.bpm.toFixed(1) : "-"}<StatusStripUnit>{formatGap(pair.gap)}</StatusStripUnit></StatusStripValue>
        </StatusStripCell>
        <StatusStripCell>
          <StatusStripLabel>Key</StatusStripLabel>
          <StatusStripValue>{pair.from?.track.camelot ?? "-"} / {pair.to?.track.camelot ?? "-"}<StatusStripUnit>{pair.from && pair.to ? HARMONY_SHORT[pair.relation] : ""}</StatusStripUnit></StatusStripValue>
        </StatusStripCell>
        <StatusStripCell>
          <StatusStripLabel>Transition</StatusStripLabel>
          <StatusStripValue className="min-w-0"><span className="truncate" title={pair.type ?? undefined}>{pair.type ?? "-"}</span></StatusStripValue>
        </StatusStripCell>
        <StatusStripCell>
          <StatusStripLabel>Length</StatusStripLabel>
          <StatusStripValue>{pair.beats ?? "-"}<StatusStripUnit>{pair.beats ? `beats · ${pair.seconds?.toFixed(1)} s` : ""}</StatusStripUnit></StatusStripValue>
        </StatusStripCell>
        <StatusStripCell>
          <StatusStripLabel>{mixing ? "Mixing" : "Mix in"}</StatusStripLabel>
          <StatusStripValue>{mixing ? pct(transition.progress)
            : <Countdown mediaTime={p.mediaTime} deck={fromDeck} outAt={auto.enabled ? plan?.outAt ?? null : null} rate={fromDeck ? decks[fromDeck].rate : 1} playing={fromDeck ? decks[fromDeck].playing : false}/>}
          </StatusStripValue>
        </StatusStripCell>
      </StatusStrip>
    </FrameBody>

    <FrameBody>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-2">
          <Meter value={value ?? 0} min={0} max={100} warnAt={null} failAt={null} size="sm" aria-valuetext={value === null ? "No score" : `${Math.round(value)} of 100`}>
            <MeterLabel>Compatibility score</MeterLabel>
            <MeterValue>{() => value === null ? "-" : `${Math.round(value)} / 100`}</MeterValue>
          </Meter>
          <ul className="flex flex-col" aria-label="Score by criterion">
            {(["harmony", "tempo", "energy"] as const).map(key => {
              const c = score?.criteria[key];
              return <li key={key} className="rule-row flex items-baseline gap-2 py-1">
                <span className="w-16 shrink-0 type-label-sm text-text-2">{key === "harmony" ? "Key" : key === "tempo" ? "Tempo" : "Energy"}</span>
                <span className="w-14 shrink-0 type-code-sm">{c?.status === "ok" ? pct(c.value) : c?.status === "missing" ? "No data" : "-"}</span>
                <span className="min-w-0 flex-1 type-caption text-text-2">{c?.note ?? ""}</span>
              </li>;
            })}
          </ul>
          <p className="type-caption text-text-2">{score ? `${confidenceWord(score.confidence)} confidence in the analysis behind this score (${pct(score.confidence)}).` : plan ? "The planner has not rated this plan." : "Load the next track to see how it mixes."}</p>
          {p.fallback && <p className="type-caption text-warn-text">{p.fallback}</p>}
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          {plan ? <MixCurves plan={plan} from={fromDeck} to={pair.to?.deck ?? null} progress={mixing ? transition.progress : null}/>
            : <p className="type-body-sm text-text-2">No transition planned yet. AutoMix plans one when a track plays and the next one is ready.</p>}
          {mixing && <Progress value={Math.round(transition.progress * 100)} max={100} size="sm">
            <ProgressLabel>{deckWord(transition.from)} into {deckWord(transition.to).toLowerCase()}</ProgressLabel>
            <ProgressValue>{(_, v) => `${v}%`}</ProgressValue>
          </Progress>}
        </div>
      </div>
    </FrameBody>

    <FrameBody>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <QueueList rows={rows} smart={auto.queue.smart} unqueued={unqueued} locked={mixing || auto.skipPending} actions={queue}/>
        <AutoMixSettings style={p.style} onStyle={p.onStyle} smart={auto.queue.smart} loop={auto.queue.loop} onSmart={queue.setSmart} onLoop={queue.setLoop} services={p.services}/>
      </div>
    </FrameBody>

    <FrameFooter>
      <FrameMeta className="whitespace-normal" aria-live="polite"><TextSwap>{detail || (auto.enabled ? (anyPlaying ? "AutoMix follows the queue." : "AutoMix is on: press Play queue, or play a deck, and it mixes each track at its out point.")
        : "Play queue starts the set. Or turn AutoMix on while you play a deck, and it mixes the queue in at each out point.")}</TextSwap></FrameMeta>
      <Field orientation="horizontal" className="w-auto gap-2">
        <FieldLabel>AutoMix</FieldLabel>
        <Switch checked={auto.enabled} onCheckedChange={toggle}/>
      </Field>
    </FrameFooter>
  </Frame>;
});
