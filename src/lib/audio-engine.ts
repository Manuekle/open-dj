import type { DeckId, EffectName } from "@/lib/types";

type AudioEffect = { input: AudioNode; output: AudioNode };
type InternalDeck = {
  media: HTMLAudioElement;
  low: BiquadFilterNode;
  mid: BiquadFilterNode;
  high: BiquadFilterNode;
  filter: BiquadFilterNode;
  dry: GainNode;
  wet: GainNode;
  analyser: AnalyserNode;
  channel: GainNode;
  cross: GainNode;
  effects: Record<Exclude<EffectName,"off"|"filter">,AudioEffect>;
  activeEffect: EffectName;
};

export class DJEngine {
  readonly context: AudioContext;
  readonly master: GainNode;
  readonly recordBus: MediaStreamAudioDestinationNode;
  readonly decks: Record<DeckId,InternalDeck>;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private flangerLfos: OscillatorNode[] = [];

  constructor() {
    this.context = new AudioContext();
    this.master = this.context.createGain();
    this.master.gain.value = 0.9;
    this.recordBus = this.context.createMediaStreamDestination();
    this.master.connect(this.context.destination);
    this.master.connect(this.recordBus);
    this.decks = { A: this.makeDeck(), B: this.makeDeck() };
    this.setCrossfader(0);
  }

  private makeDeck():InternalDeck {
    const ctx=this.context;
    const media=new Audio();
    media.preload="metadata";
    media.crossOrigin="anonymous";
    const source=ctx.createMediaElementSource(media);
    const low=ctx.createBiquadFilter();low.type="lowshelf";low.frequency.value=280;
    const mid=ctx.createBiquadFilter();mid.type="peaking";mid.frequency.value=1100;mid.Q.value=0.75;
    const high=ctx.createBiquadFilter();high.type="highshelf";high.frequency.value=4400;
    const filter=ctx.createBiquadFilter();filter.type="lowpass";filter.frequency.value=20000;
    const dry=ctx.createGain();
    const wet=ctx.createGain();wet.gain.value=0.4;
    const analyser=ctx.createAnalyser();analyser.fftSize=512;
    const channel=ctx.createGain();channel.gain.value=0.82;
    const cross=ctx.createGain();
    source.connect(low);low.connect(mid);mid.connect(high);high.connect(filter);
    filter.connect(dry);dry.connect(analyser);wet.connect(analyser);
    analyser.connect(channel);channel.connect(cross);cross.connect(this.master);

    const delay=ctx.createDelay(1.0);delay.delayTime.value=0.29;
    const feedback=ctx.createGain();feedback.gain.value=0.3;
    delay.connect(feedback);feedback.connect(delay);

    const convolver=ctx.createConvolver();
    const impulse=ctx.createBuffer(2,Math.floor(ctx.sampleRate*1.6),ctx.sampleRate);
    for(let ch=0;ch<impulse.numberOfChannels;ch++){
      const out=impulse.getChannelData(ch);
      for(let i=0;i<out.length;i++)out[i]=(Math.random()*2-1)*Math.pow(1-i/out.length,2.9);
    }
    convolver.buffer=impulse;

    const flanger=ctx.createDelay(0.04);flanger.delayTime.value=0.005;
    const lfo=ctx.createOscillator();lfo.frequency.value=0.3;
    const lfoGain=ctx.createGain();lfoGain.gain.value=0.003;
    lfo.connect(lfoGain);lfoGain.connect(flanger.delayTime);lfo.start();
    this.flangerLfos.push(lfo);

    const phaser=ctx.createBiquadFilter();phaser.type="allpass";phaser.frequency.value=1100;phaser.Q.value=3;
    const crusher=ctx.createWaveShaper();const curve=new Float32Array(8192);
    for(let i=0;i<curve.length;i++){const x=(i/(curve.length-1))*2-1;curve[i]=Math.round(x*16)/16;}
    crusher.curve=curve;
    return {media,low,mid,high,filter,dry,wet,analyser,channel,cross,
      effects:{echo:{input:delay,output:delay},reverb:{input:convolver,output:convolver},
      flanger:{input:flanger,output:flanger},phaser:{input:phaser,output:phaser},
      crush:{input:crusher,output:crusher}},
      activeEffect:"off"};
  }

  getMedia(id:DeckId){return this.decks[id].media;}
  load(id:DeckId,src:string){
    const media=this.getMedia(id);
    media.pause();media.src=src;media.load();media.playbackRate=1;media.currentTime=0;
  }
  async play(id:DeckId){
    await this.context.resume();
    const media=this.getMedia(id);
    if (!media.src) throw new Error("Carga una canción en el deck");
    await media.play();
  }
  pause(id:DeckId){this.getMedia(id).pause();}
  seek(id:DeckId,position:number){
    const media=this.getMedia(id);
    if(!media.src) return;
    media.currentTime=Math.max(0,Math.min(Number.isFinite(media.duration)?media.duration:position,position));
  }
  setRate(id:DeckId,rate:number){this.getMedia(id).playbackRate=Math.max(0.5,Math.min(1.5,rate));}
  setVolume(id:DeckId,value:number){this.decks[id].channel.gain.setTargetAtTime(Math.max(0,Math.min(1,value)),this.context.currentTime,0.01);}
  setMaster(value:number){this.master.gain.setTargetAtTime(Math.max(0,Math.min(1,value)),this.context.currentTime,0.01);}
  setEQ(id:DeckId,band:"high"|"mid"|"low",value:number){
    this.decks[id][band].gain.setTargetAtTime(Math.max(-24,Math.min(12,value)),this.context.currentTime,0.01);
  }
  setCrossfader(value:number){
    const theta=(Math.max(-1,Math.min(1,value))+1)*Math.PI/4;
    this.decks.A.cross.gain.setTargetAtTime(Math.cos(theta),this.context.currentTime,0.01);
    this.decks.B.cross.gain.setTargetAtTime(Math.sin(theta),this.context.currentTime,0.01);
  }
  setEffect(id:DeckId,effect:EffectName,amount:number){
    const d=this.decks[id];
    d.filter.disconnect();
    d.filter.type="lowpass";
    d.filter.frequency.setTargetAtTime(effect==="filter"?Math.max(240,20000*(1-amount)**3):20000,this.context.currentTime,0.012);
    d.filter.connect(d.dry);
    d.dry.gain.value=effect==="off"||effect==="filter"?1:1-amount*0.25;
    d.wet.gain.value=Math.max(0,Math.min(0.95,amount*0.7));
    if(effect!=="off"&&effect!=="filter"){
      const fx=d.effects[effect];
      fx.output.disconnect();
      fx.output.connect(d.wet);
      d.filter.connect(fx.input);
    }
    d.activeEffect=effect;
  }
  getLevel(id:DeckId){
    const analyser=this.decks[id].analyser;
    const data=new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    let sum=0;
    for(let i=0;i<data.length;i++)sum+=data[i];
    return sum/data.length/255;
  }
  get recording(){return this.recorder?.state==="recording";}
  startRecording(onDone:(blob:Blob,mime:string,duration:number)=>void){
    if(this.recorder?.state==="recording")return;
    if(typeof MediaRecorder==="undefined")throw new Error("Este navegador no admite grabar audio");
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
    for(const deck of Object.values(this.decks)){deck.media.pause();deck.media.removeAttribute("src");deck.media.load();}
    this.flangerLfos.forEach(osc=>{try{osc.stop();}catch{}});
    void this.context.close();
  }
}
