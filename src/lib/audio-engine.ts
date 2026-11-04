import { ClockMap } from "@/lib/clock";
import { applyColor, applyEffect, applyEffectTime, createDeckGraph, type DeckGraph } from "@/lib/deck-graph";
import { MixSession, crossGains, type MixSpec } from "@/lib/mix-session";
import type { DeckId, EffectName } from "@/lib/types";

type InternalDeck = DeckGraph & {
  media: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
  /** Whether the browser keeps pitch when this element's playbackRate is not 1. */
  pitchLock: boolean;
};

type PitchMedia = HTMLAudioElement & { webkitPreservesPitch?: boolean; mozPreservesPitch?: boolean };
/** Asks the element to keep pitch under a rate change (the default, but stated, so no later code can turn it off), and
    reports whether the browser says it does. */
function lockPitch(media: HTMLAudioElement) {
  const m = media as PitchMedia;
  if ("preservesPitch" in m) m.preservesPitch = true;
  if ("webkitPreservesPitch" in m) m.webkitPreservesPitch = true;
  if ("mozPreservesPitch" in m) m.mozPreservesPitch = true;
  return m.preservesPitch === true || m.webkitPreservesPitch === true || m.mozPreservesPitch === true;
}

/** Highest sample the master can send out, linear (about -0.3 dBFS). */
export const CEILING = 0.968;
const KNEE = 0.9;
/** A curve that passes the signal untouched up to KNEE, then bends it into CEILING along a tanh with the same slope at
    the knee, so the bend has no corner. Input past full scale reads the curve's last point, still under CEILING. */
function clipCurve(points = 8193) {
  const curve = new Float32Array(points), room = CEILING - KNEE;
  for (let i = 0; i < points; i++) {
    const x = i / (points - 1) * 2 - 1, a = Math.abs(x);
    curve[i] = Math.sign(x) * (a <= KNEE ? a : KNEE + room * Math.tanh((a - KNEE) / room));
  }
  return curve;
}
/**
 * The master bus: its gain, a limiter for overs that last (a compressor at -1 dBFS, ratio 20, 1 ms attack, no knee, so
 * nothing below -1 dBFS is touched), then a soft clipper for the transients that get past the limiter's attack. The
 * clipper is a straight line up to 0.9 and holds everything above under CEILING, so the converter never clips, however
 * loud both decks run together.
 */
export function createMasterBus(ctx: BaseAudioContext) {
  const input = ctx.createGain();
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -1; limiter.knee.value = 0; limiter.ratio.value = 20;
  limiter.attack.value = 0.001; limiter.release.value = 0.12;
  // A compressor raises everything by a makeup gain worked out from its curve (0.6 of the gain it takes off full scale,
  // Web Audio spec); taking it back out keeps the bus at unity below the threshold.
  const makeup = ctx.createGain();
  makeup.gain.value = 10 ** (-0.6 * -(limiter.threshold.value * (1 - 1 / limiter.ratio.value)) / 20);
  const clipper = ctx.createWaveShaper();
  clipper.curve = clipCurve();
  clipper.oversample = "none";
  input.connect(limiter); limiter.connect(makeup); makeup.connect(clipper);
  return { input, limiter, output: clipper as AudioNode };
}

export class DJEngine {
  readonly context: AudioContext;
  readonly master: GainNode;
  readonly limiter: DynamicsCompressorNode;
  readonly recordBus: MediaStreamAudioDestinationNode;
  readonly decks: Record<DeckId,InternalDeck>;
  /** Performance clock to context clock, for placing a media position on the audio timeline. */
  readonly clock = new ClockMap();
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private mix: { session: MixSession; from: DeckId; to: DeckId } | null = null;
  /** The crossfader's own position. While a mix runs it is only remembered: the mix owns the fader gains. */
  private crossValue = 0;

  constructor() {
    this.context = new AudioContext();
    const bus = createMasterBus(this.context);
    this.master = bus.input;
    this.master.gain.value = 0.9;
    this.limiter = bus.limiter;
    this.recordBus = this.context.createMediaStreamDestination();
    bus.output.connect(this.context.destination);
    bus.output.connect(this.recordBus);
    this.decks = { A: this.makeDeck(), B: this.makeDeck() };
    this.setCrossfader(0);
    this.sampleClock();
  }

  private makeDeck():InternalDeck {
    const ctx=this.context;
    const media=new Audio();
    // "auto": the browser buffers a loaded track ahead of its first play, so the incoming deck of a mix starts without a fetch.
    media.preload="auto";
    media.crossOrigin="anonymous";
    const pitchLock=lockPitch(media);
    const source=ctx.createMediaElementSource(media);
    const graph=createDeckGraph(ctx,this.master);
    source.connect(graph.input);
    return {...graph,media,source,pitchLock};
  }

  /** Whether both decks keep pitch under a tempo change. When they do not, a tempo match past a few cents is a pitch shift. */
  get pitchLock(){return this.decks.A.pitchLock&&this.decks.B.pitchLock;}
  getMedia(id:DeckId){return this.decks[id].media;}
  /** Whether a deck plays a stems file (so the vocals lane and the stem gains act on its signal), not a plain track. */
  stemMode(id:DeckId){return this.decks[id].stemMode;}
  /** stems: src is a stems file, played through the per-stem gains. at: where to start, in seconds. */
  load(id:DeckId,src:string,stems=false,at=0){
    const d=this.decks[id];const media=d.media;
    media.pause();media.src=src;media.load();media.playbackRate=1;d.pitchLock=lockPitch(media);media.currentTime=at;
    if(d.stemMode!==stems){d.source.disconnect();d.source.connect(stems?d.splitter:d.input);d.stemMode=stems;}
    d.stems.forEach(g=>g.gain.setValueAtTime(1,this.context.currentTime));
  }
  /** Fades one stem in or out over a few ms, so a mute lands without a click. */
  setStem(id:DeckId,index:number,on:boolean){this.setStemGain(id,index,on?1:0);}
  /** One stem's level, 0..1. */
  setStemGain(id:DeckId,index:number,gain:number){this.decks[id].stems[index]?.gain.setTargetAtTime(Math.max(0,Math.min(1,gain)),this.context.currentTime,0.015);}
  async play(id:DeckId){
    await this.context.resume();
    const media=this.getMedia(id);
    if (!media.src) throw new Error("Load a track on this deck first");
    await media.play();
  }
  pause(id:DeckId){this.getMedia(id).pause();}
  seek(id:DeckId,position:number){
    const media=this.getMedia(id);
    if(!media.src) return;
    media.currentTime=Math.max(0,Math.min(Number.isFinite(media.duration)?media.duration:position,position));
  }
  setRate(id:DeckId,rate:number){
    const d=this.decks[id];
    d.media.playbackRate=Math.max(0.5,Math.min(1.5,rate));
    // Setting a rate has been seen to reset the lock in some engines; state it again.
    d.pitchLock=lockPitch(d.media);
  }
  setVolume(id:DeckId,value:number){this.decks[id].channel.gain.setTargetAtTime(Math.max(0,Math.min(1,value)),this.context.currentTime,0.01);}
  setMaster(value:number){this.master.gain.setTargetAtTime(Math.max(0,Math.min(1,value)),this.context.currentTime,0.01);}
  setEQ(id:DeckId,band:"high"|"mid"|"low",value:number){
    this.decks[id][band].gain.setTargetAtTime(Math.max(-24,Math.min(12,value)),this.context.currentTime,0.01);
  }
  /** Gain before the EQ, in dB. */
  setTrim(id:DeckId,db:number){this.decks[id].trim.gain.setTargetAtTime(10**(Math.max(-24,Math.min(12,db))/20),this.context.currentTime,0.01);}
  setColor(id:DeckId,value:number){applyColor(this.context,this.decks[id],value);}
  setCrossfader(value:number){
    this.crossValue=Math.max(-1,Math.min(1,value));
    if(this.mixing)return;
    const g=crossGains(this.crossValue);
    this.decks.A.cross.gain.setTargetAtTime(g.A,this.context.currentTime,0.01);
    this.decks.B.cross.gain.setTargetAtTime(g.B,this.context.currentTime,0.01);
  }
  setEffect(id:DeckId,effect:EffectName,amount:number){applyEffect(this.context,this.decks[id],effect,amount);}
  /** Times a deck's echo, flanger and phaser to its tempo: `beat` heard seconds per beat, `beats` the effect's division. */
  setEffectTime(id:DeckId,beat:number|null,beats:number){applyEffectTime(this.context,this.decks[id],beat,beats);}

  /** Samples the performance and context clocks together. Call it on every poll; it keeps the map between them smooth. */
  sampleClock(){this.clock.sample(performance.now()/1000,this.context.currentTime);}
  /** The context time a performance time (seconds) falls at. */
  contextTimeAt(perfSeconds:number){return this.clock.at(perfSeconds);}

  /** Whether a mix is writing the faders. */
  get mixing(){
    if(!this.mix)return false;
    if(this.mix.session.isOver(this.context.currentTime))this.endMix();
    return !!this.mix;
  }
  get mixSession(){return this.mix?.session??null;}
  /** Keeps the incoming deck silent inside the mix, ahead of its preroll, whatever the crossfader gives it. */
  prepareMix(to:DeckId){
    const lane=this.decks[to].mix.volume.gain;
    lane.cancelScheduledValues(this.context.currentTime);
    lane.setTargetAtTime(0,this.context.currentTime,0.005);
  }
  /**
   * Writes a transition to the audio thread: volume, bass, filters, send, vocals and the crossfader hand-off, all as
   * AudioParam events against the context clock from `start` (context time) for `duration` seconds. Returns the session
   * so the caller can re-anchor or cancel it; it needs nothing else from the main thread to finish.
   */
  scheduleMix(opts:{from:DeckId;to:DeckId;plan:MixSpec["plan"];start:number;duration:number;outStart:number;handover:boolean;beat?:number}){
    this.cancelMix();
    const rest=crossGains(this.crossValue),final=crossGains(opts.to==="B"?1:-1);
    const session=new MixSession(this.context,{
      plan:opts.plan,from:this.decks[opts.from],to:this.decks[opts.to],start:opts.start,duration:opts.duration,outStart:opts.outStart,
      rest:{from:rest[opts.from],to:rest[opts.to]},final:{from:final[opts.from],to:final[opts.to]},handover:opts.handover,beat:opts.beat,
    });
    session.schedule();
    this.mix={session,from:opts.from,to:opts.to};
    return session;
  }
  /** Stops a running or prepared mix and gives every lane back to rest, so nothing it scheduled outlives it. */
  cancelMix(to?:DeckId){
    const t=this.context.currentTime;
    if(this.mix){this.mix.session.cancel();this.mix=null;return;}
    if(to){
      // Only the preroll had begun: the incoming deck's silenced lane goes back to rest.
      const lane=this.decks[to].mix.volume.gain;
      lane.cancelScheduledValues(t);lane.setTargetAtTime(1,t,0.05);
    }
  }
  /** Marks a finished mix done, and hands the crossfader back to the DJ. */
  endMix(){
    if(!this.mix)return;
    this.mix.session.finish();
    this.mix=null;
  }
  getLevel(id:DeckId){
    const analyser=this.decks[id].analyser;
    const data=new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    let sum=0;
    for(let i=0;i<data.length;i++)sum+=data[i];
    return sum/data.length/255;
  }
  /** What the browser reports about the audio path, for the diagnostics page. */
  info(){
    const c=this.context as AudioContext&{outputLatency?:number};
    return {sampleRate:c.sampleRate,baseLatency:c.baseLatency,outputLatency:c.outputLatency??null,pitchLock:this.pitchLock};
  }
  get recording(){return this.recorder?.state==="recording";}
  startRecording(onDone:(blob:Blob,mime:string,duration:number)=>void){
    if(this.recorder?.state==="recording")return;
    if(typeof MediaRecorder==="undefined")throw new Error("This browser cannot record audio");
    const candidates=["audio/webm;codecs=opus","audio/mp4","audio/webm"];
    const mime=candidates.find(x=>MediaRecorder.isTypeSupported(x))||"";
    const recorder=new MediaRecorder(this.recordBus.stream,mime?{mimeType:mime}:undefined);
    this.chunks=[];
    this.startedAt=Date.now();
    recorder.ondataavailable=(ev)=>{if(ev.data.size)this.chunks.push(ev.data);};
    recorder.onstop=()=>{
      const type=recorder.mimeType||mime||"audio/webm";
      onDone(new Blob(this.chunks,{type}),type,(Date.now()-this.startedAt)/1000);
      this.chunks=[];
      this.recorder=null;
    };
    recorder.start(1000);
    this.recorder=recorder;
  }
  stopRecording(){
    if(this.recorder?.state==="recording")this.recorder.stop();
  }
  destroy(){
    this.stopRecording();
    for(const deck of Object.values(this.decks)){
      deck.media.pause();deck.media.removeAttribute("src");deck.media.load();
      for(const fx of [...Object.values(deck.effects),...Object.values(deck.mix.rack)])try{fx.lfo?.stop();}catch{}
    }
    void this.context.close();
  }
}
