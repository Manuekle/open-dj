"use client";

import { useRef } from "react";
import { Pause, Play } from "lucide-react";
import type { DeckId, DeckState } from "@/lib/types";

type KnobProps={label:string;value:number;min:number;max:number;onChange:(value:number)=>void;small?:boolean};
export function Knob({label,value,min,max,onChange,small=false}:KnobProps){
  const last=useRef<number|null>(null);
  const angle=-135+(value-min)/(max-min)*270;
  const update=(delta:number)=>onChange(Math.max(min,Math.min(max,Math.round((value+delta)*100)/100)));
  return <div className="hw-knob-group">
    <span className="hw-knob-label">{label}</span>
    <button type="button" className={"hw-knob "+(small?"small":"")} role="slider"
      aria-label={label} aria-valuemin={min} aria-valuemax={max} aria-valuenow={value}
      title={label+" "+value.toFixed(1)}
      onDoubleClick={()=>onChange(min<0?0:(min+max)/2)}
      onPointerDown={e=>{last.current=e.clientY;e.currentTarget.setPointerCapture(e.pointerId);}}
      onPointerMove={e=>{if(last.current===null)return;const dy=last.current-e.clientY;last.current=e.clientY;if(dy)update(dy*(max-min)/180);}}
      onPointerUp={()=>last.current=null} onPointerCancel={()=>last.current=null}
      onKeyDown={e=>{if(e.key==="ArrowUp"||e.key==="ArrowRight"){e.preventDefault();update((max-min)/30);}if(e.key==="ArrowDown"||e.key==="ArrowLeft"){e.preventDefault();update(-(max-min)/30);}}}>
      <span className="hw-knob-face" style={{transform:"rotate("+angle+"deg)"}}><span className="hw-knob-tick"/></span>
    </button>
  </div>;
}

type DeckControls={
  id:DeckId; deck:DeckState; hasTrack:boolean;
  onPlay:()=>void;onCue:()=>void;onSync:()=>void;onNudge:(seconds:number)=>void;
  onPad:(index:number)=>void;onLoop:()=>void;onRate:(rate:number)=>void;onLoopBeats:(beats:4|8|16)=>void;
};
export function HardwareDeck({id,deck,hasTrack,onPlay,onCue,onSync,onNudge,onPad,onLoop,onRate,onLoopBeats}:DeckControls){
  const prev=useRef<number|null>(null);
  return <section className="hw-deck" aria-label={"Controlador deck "+id}>
    <div className="hw-deck-head"><span className="hw-deck-number">{id==="A"?"1":"2"}</span><span className="hw-deck-caption">OPEN DJ · DIGITAL DECK</span></div>
    <div className="hw-deck-top">
      <div className={"jog "+(deck.playing?"is-spinning":"")} role="slider" tabIndex={0}
        aria-label={"Jog wheel deck "+id} aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={deck.duration?Math.round(deck.position/deck.duration*100):0}
        title="Arrastra para buscar, o usa la rueda para ajustar"
        onWheel={e=>{onNudge(e.deltaY>0?-1:1);}}
        onPointerDown={e=>{prev.current=e.clientX;e.currentTarget.setPointerCapture(e.pointerId);}}
        onPointerMove={e=>{if(prev.current===null)return;const diff=e.clientX-prev.current;prev.current=e.clientX;if(diff)onNudge(diff/10);}}
        onPointerUp={()=>prev.current=null} onPointerCancel={()=>prev.current=null}
        onKeyDown={e=>{if(e.key==="ArrowLeft")onNudge(-1);if(e.key==="ArrowRight")onNudge(1);}}>
        <div className="jog-ridges"/>
        <div className="jog-platter"><div className="jog-strokes"><div className="jog-inner"><div className="jog-core"/></div></div></div>
      </div>
      <div className="hw-pitch">
        <div className="hw-pitch-label">TEMPO</div>
        <input type="range" aria-label={"Tempo deck "+id} className="hw-vertical-range" min={0.75} max={1.25} step={0.001}
          value={deck.rate} disabled={!hasTrack} onChange={e=>onRate(Number(e.target.value))}/>
        <span className="hw-pitch-value">{((deck.rate-1)*100).toFixed(1)}%</span>
      </div>
    </div>
    <div className="hw-deck-bottom">
      <div className="hw-deck-rounds">
        <button type="button" className="hw-mini-button" onClick={onSync} disabled={!hasTrack}>BEAT<br/>SYNC</button>
        <button type="button" className="hw-cue-button" onClick={onCue} disabled={!hasTrack}>CUE</button>
        <button type="button" className={"hw-play-button "+(deck.playing?"active":"")} onClick={onPlay} disabled={!hasTrack} aria-label={deck.playing?"Pausar":"Reproducir"}>
          {deck.playing?<Pause size={18} fill="currentColor"/>:<Play size={18} fill="currentColor"/>}
        </button>
      </div>
      <div className="hw-pad-area">
        <div className="hw-pad-head"><span>HOT CUE</span><span>PAD FX</span><span>LOOP</span><span>SAMPLER</span></div>
        <div className="hw-pad-grid">
          {deck.hotCues.map((cue,i)=><button key={i} type="button" disabled={!hasTrack} className={"hw-pad "+(cue!==null?"hot":"")}
            onClick={()=>onPad(i)} title={cue===null?"Crear hot cue "+(i+1):"Saltar a hot cue "+(i+1)} aria-label={"Hot cue "+(i+1)}/>)}
        </div>
        <span className="hw-pads-label">PERFORMANCE PADS</span>
        <div className="hw-pad-grid">
          {[4,8,16,0].map((n,i)=><button key={i} type="button" disabled={!hasTrack}
            className={"hw-pad "+((n===0&&deck.loopEnd!==null)||(n!==0&&deck.loopBeats===n)?"hot":"")}
            onClick={()=>n===0?onLoop():onLoopBeats(n as 4|8|16)}
            title={n===0?"Activar / quitar loop":n+" beats loop"} aria-label={n===0?"Activar loop":n+" beats"}/>)}
        </div>
      </div>
    </div>
    <div className="hw-deck-footer"><span>SHIFT</span><span>{id==="A"?"DECK A":"DECK B"} • {deck.loopEnd!==null?"LOOP ACTIVE":"4 HOT CUES"}</span></div>
  </section>;
}

type HardwareProps={
  a:DeckState;b:DeckState;hasA:boolean;hasB:boolean;cross:number;
  onCross:(n:number)=>void;onPlay:(id:DeckId)=>void;onCue:(id:DeckId)=>void;onSync:(id:DeckId)=>void;
  onNudge:(id:DeckId,n:number)=>void;onPad:(id:DeckId,index:number)=>void;onLoop:(id:DeckId)=>void;
  onRate:(id:DeckId,n:number)=>void;onLoopBeats:(id:DeckId,n:4|8|16)=>void;
  onEQ:(id:DeckId,band:"high"|"mid"|"low",n:number)=>void;onVol:(id:DeckId,n:number)=>void;
  onFX:(id:DeckId,n:number)=>void;
};
export function DJController(props:HardwareProps){
  const render=(id:DeckId,deck:DeckState,hasTrack:boolean)=><HardwareDeck id={id} deck={deck} hasTrack={hasTrack}
    onPlay={()=>props.onPlay(id)} onCue={()=>props.onCue(id)} onSync={()=>props.onSync(id)}
    onNudge={n=>props.onNudge(id,n)} onPad={n=>props.onPad(id,n)}
    onLoop={()=>props.onLoop(id)} onLoopBeats={n=>props.onLoopBeats(id,n)}
    onRate={n=>props.onRate(id,n)}/>;
  return <div className="hardware-shell">
    <div className="hardware-board">
      {render("A",props.a,props.hasA)}
      <section className="hw-mixer" aria-label="Mezclador central">
        <div className="hw-mixer-led"><i/><span>USB</span><i/></div>
        <div className="hw-brand"><span>OPEN DJ</span><strong>PRO</strong></div>
        <div className="hw-eq-grid">
          {(["high","mid","low"] as const).map((band)=><div className="hw-eq-row" key={band}>
            <Knob label={band.toUpperCase()} small value={props.a.eq[band]} min={-24} max={12} onChange={n=>props.onEQ("A",band,n)}/>
            <span className="hw-eq-mid">{band==="high"?"EQ":band==="mid"?"MID":"LOW"}</span>
            <Knob label={band.toUpperCase()} small value={props.b.eq[band]} min={-24} max={12} onChange={n=>props.onEQ("B",band,n)}/>
          </div>)}
        </div>
        <div className="hw-headphone"><span>MASTER</span><small>SMART FX</small><span>HEADPHONES</span><div><b>1</b><b>2</b></div></div>
        <div className="hw-fx-row">
          <Knob label="CFX" value={props.a.fxAmount} min={0} max={1} onChange={n=>props.onFX("A",n)}/>
          <div className="hw-fx-logo"><span>◉</span><small>WEB AUDIO</small></div>
          <Knob label="CFX" value={props.b.fxAmount} min={0} max={1} onChange={n=>props.onFX("B",n)}/>
        </div>
        <div className="hw-channel-faders">
          <label><span>CH 1</span><input className="hw-vertical-range" type="range" min={0} max={1} step={0.01} value={props.a.volume} onChange={e=>props.onVol("A",Number(e.target.value))} aria-label="Volumen canal 1"/></label>
          <div className="hw-levels"><span/><span/><span/><span/><span/><span/></div>
          <label><span>CH 2</span><input className="hw-vertical-range" type="range" min={0} max={1} step={0.01} value={props.b.volume} onChange={e=>props.onVol("B",Number(e.target.value))} aria-label="Volumen canal 2"/></label>
        </div>
        <div className="hw-crossfader"><span>CROSSFADER</span><input type="range" min={-1} max={1} step={0.01} value={props.cross} onChange={e=>props.onCross(Number(e.target.value))} aria-label="Crossfader deck A / deck B"/><div><span>A</span><span>B</span></div></div>
      </section>
      {render("B",props.b,props.hasB)}
    </div>
  </div>;
}
