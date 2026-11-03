// Analysis happens on the user's device; no file is sent to a service.
export async function analyzeFile(blob: Blob): Promise<{ duration: number; peaks: number[]; bpm: number|null }> {
  const bytes = await blob.arrayBuffer();
  const context = new OfflineAudioContext(1,1,44100);
  const audio = await context.decodeAudioData(bytes);
  const channel = audio.getChannelData(0);
  const bins = 160;
  const peaks: number[] = [];
  const stride = Math.max(1,Math.floor(channel.length / bins));
  for (let i=0;i<bins;i++) {
    const start = i*stride;
    const end = Math.min(channel.length,start+stride);
    let peak=0;
    const jump=Math.max(1,Math.floor((end-start)/450));
    for(let j=start;j<end;j+=jump) peak=Math.max(peak,Math.abs(channel[j]||0));
    peaks.push(Math.max(0.065,Math.min(1,Math.pow(peak,0.68))));
  }
  // Simple onset-envelope autocorrelation; a helpful estimate, not beat-grid precision.
  const windowSize=1024;
  const envelope:number[]=[];
  for(let i=0;i<channel.length;i+=windowSize*3) {
    let energy=0;
    for(let j=i;j<Math.min(i+windowSize*3,channel.length);j+=4) energy+=Math.abs(channel[j]);
    envelope.push(energy);
  }
  const novelty=envelope.map((x,i)=>Math.max(0,x-(envelope[i-1]||x)));
  const rate=audio.sampleRate/(windowSize*3);
  let best=0;
  let bestScore=0;
  for(let bpm=80;bpm<=160;bpm++) {
    const lag=Math.round(rate*60/bpm);
    if(lag<1) continue;
    let sum=0;
    for(let i=lag;i<novelty.length;i++) sum+=novelty[i]*novelty[i-lag];
    if(sum>bestScore){bestScore=sum;best=bpm;}
  }
  const bpm = audio.duration>=10 && bestScore>0 ? best : null;
  return {duration:audio.duration,peaks,bpm};
}
export function inferName(fileName:string):{title:string;artist:string} {
  const clean=fileName.replace(/\.[^.]+$/,"").replace(/_/g," ").trim();
  const parts=clean.split(/\s[-–—]\s/);
  return parts.length>=2 ? {artist:parts[0],title:parts.slice(1).join(" - ")} : {title:clean||"Pista sin nombre",artist:"Archivo local"};
}
