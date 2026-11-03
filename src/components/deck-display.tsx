"use client";

import { Pause, Play, RotateCcw, SkipBack, UploadCloud, Volume2, Waves } from "lucide-react";
import { formatTime, type DeckId, type DeckState, type Track } from "@/lib/types";

type Props={
  id:DeckId; deck:DeckState; track?:Track; selected:boolean;
  onSelect:()=>void;onPlay:()=>void;onCue:()=>void;onSync:()=>void;
  onLoop:()=>void;onSeek:(value:number)=>void;onUpload:()=>void;
};
export function DeckDisplay({id,deck,track,selected,onSelect,onPlay,onCue,onSync,onLoop,onSeek,onUpload}:Props){
  const bars=track?.peaks?.length ? track.peaks : Array.from({length:160},(_,i)=>0.05+0.11*Math.abs(Math.sin(i*.57)));
  const percent=deck.duration ? Math.max(0,Math.min(1,deck.position/deck.duration)):0;
  const accent=id==="A"?"var(--orange)":"var(--green)";
  const width=800;
  const waveform=<svg viewBox="0 0 800 88" preserveAspectRatio="none" aria-hidden="true">
    <defs><clipPath id={"wave-clip-"+id}><rect x="0" y="0" width={width*percent} height="88"/></clipPath></defs>
    <g fill="#45474e">{bars.map((n,i)=><rect key={i} x={i*5.0} y={44-Math.max(2,n*37)} width={3.5} height={Math.max(4,n*74)} rx="1"/>)}</g>
    <g fill={accent} clipPath={"url(#wave-clip-"+id+")"}>{bars.map((n,i)=><rect key={i} x={i*5.0} y={44-Math.max(2,n*37)} width={3.5} height={Math.max(4,n*74)} rx="1"/>)}</g>
    {track&&<line x1={width*percent} x2={width*percent} y1="1" y2="87" stroke={accent} strokeWidth="2"/>}
  </svg>;
  return <article className={"deck-display panel "+(selected?"selected":"")} onClick={onSelect} aria-label={"Deck "+id}>
    <div className="deck-display-head">
      <div className={"album-art "+(id==="A"?"art-orange":"art-green")}>{track?<Waves size={24}/>:<UploadCloud size={25}/>}</div>
      <div className="deck-title-block">
        <span className="deck-badge">DECK {id}</span>
        <h2 title={track?.title}>{track?.title||"Deck sin canción"}</h2>
        <p>{track?.artist||"Añade una pista MP3 para comenzar"}</p>
      </div>
      <div className="deck-meta">
        <span className="meta-chip">{track?.bpm ? Math.round(track.bpm*deck.rate)+" BPM":"— BPM"}</span>
        <span className="meta-chip">{((deck.rate-1)*100)>=0?"+":""}{((deck.rate-1)*100).toFixed(1)}%</span>
      </div>
      <div className="deck-time"><strong>{formatTime(deck.position)} <span>/ {formatTime(deck.duration)}</span></strong>
        <small className={deck.playing?"playing":""}>{deck.playing?"● Reproduciendo":track?"● Listo":"○ Sin audio"}</small>
      </div>
    </div>
    <div className="waveform" role="slider" tabIndex={track?0:-1} aria-label={"Buscar en pista deck "+id}
      aria-valuemin={0} aria-valuemax={Math.floor(deck.duration)} aria-valuenow={Math.floor(deck.position)}
      onClick={e=>{if(!track)return;const r=e.currentTarget.getBoundingClientRect();onSeek((e.clientX-r.left)/r.width*deck.duration);}}
      onKeyDown={e=>{if(e.key==="ArrowRight")onSeek(Math.min(deck.duration,deck.position+5));if(e.key==="ArrowLeft")onSeek(Math.max(0,deck.position-5));}}>
      {waveform}
      {!track&&<span className="waveform-placeholder">Arrastra un archivo o selecciónalo de la biblioteca</span>}
    </div>
    <div className="deck-actions">
      <div className="deck-action-left">
        <button className="icon-btn" type="button" onClick={onPlay} disabled={!track} aria-label={deck.playing?"Pausar":"Reproducir"}>{deck.playing?<Pause size={17}/>:<Play size={17}/>}</button>
        <button className="icon-btn" type="button" onClick={onCue} disabled={!track} aria-label="Volver al punto cue"><SkipBack size={16}/></button>
        <button className="small-pill sync" type="button" onClick={onSync} disabled={!track}>SYNC</button>
        <button className={"icon-btn "+(deck.loopEnd!==null?"on":"")} type="button" onClick={onLoop} disabled={!track} title="Loop"><RotateCcw size={17}/></button>
        <span className="loop-chip">{deck.loopBeats} BEATS</span>
      </div>
      <div className="deck-action-right">
        <Volume2 size={16} className="muted-icon"/>
        <span>{Math.round(deck.volume*100)}%</span>
        <button className="load-track-btn" type="button" onClick={onUpload}>{track?"Cambiar pista":"Cargar MP3"}</button>
      </div>
    </div>
  </article>;
}
