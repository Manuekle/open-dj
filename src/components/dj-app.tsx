"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, AudioLines, Check, CircleHelp, Clock3, Disc3, Download, FileAudio2,
  FolderOpen, Headphones, Library, Menu, Mic2, Music2, Pause, Play, Plus, Radio, Search,
  Settings2, SlidersHorizontal, Sparkles, Trash2, UploadCloud, Volume2, X } from "lucide-react";
import { DJEngine } from "@/lib/audio-engine";
import { analyzeFile, inferName } from "@/lib/analyze";
import { clearTracks, loadMixes, loadTracks, removeMix, removeTrack, saveMix, saveTrack } from "@/lib/storage";
import { formatTime, makeDeck, type DeckId, type DeckState, type EffectName, type StoredMix, type Track } from "@/lib/types";
import { DeckDisplay } from "@/components/deck-display";
import { DJController } from "@/components/controller";

const NAV=[{name:"Mixer",icon:SlidersHorizontal,target:"mixer"},{name:"Biblioteca",icon:Library,target:"library"},
  {name:"Subir archivos",icon:UploadCloud,target:"upload"},{name:"Efectos",icon:Activity,target:"effects"},
  {name:"Grabaciones",icon:Clock3,target:"recordings"},{name:"Ajustes",icon:Settings2,target:"settings"}] as const;
const EFFECTS:{id:EffectName;label:string;icon:typeof Activity;description:string}[]=[
  {id:"off",label:"Sin efecto",icon:Check,description:"Señal limpia"},
  {id:"echo",label:"Echo",icon:AudioLines,description:"Delay con feedback"},
  {id:"reverb",label:"Reverb",icon:Sparkles,description:"Reverberación"},
  {id:"filter",label:"Filter",icon:SlidersHorizontal,description:"Filtro de paso bajo"},
  {id:"flanger",label:"Flanger",icon:Activity,description:"Modulación de delay"},
  {id:"phaser",label:"Phaser",icon:Radio,description:"Barrido de fase"},
  {id:"crush",label:"Bitcrush",icon:Disc3,description:"Reducción de resolución"}
];
function downloadFile(blob:Blob,fileName:string){
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a");a.href=url;a.download=fileName;a.style.display="none";
  document.body.append(a);a.click();a.remove();
  window.setTimeout(()=>URL.revokeObjectURL(url),10000);
}
export function DJApp(){
  const engine=useRef<DJEngine|null>(null);
  const inputRef=useRef<HTMLInputElement>(null);
  const tracksRef=useRef<Track[]>([]);
  const decksRef=useRef<Record<DeckId,DeckState>>({A:makeDeck(),B:makeDeck()});
  const [tracks,setTracks]=useState<Track[]>([]);
  const [mixes,setMixes]=useState<StoredMix[]>([]);
  const [decks,setDecks]=useState<Record<DeckId,DeckState>>({A:makeDeck(),B:makeDeck()});
  const [cross,setCross]=useState(0);
  const [master,setMaster]=useState(0.9);
  const [activeDeck,setActiveDeck]=useState<DeckId>("A");
  const [activeNav,setActiveNav]=useState("Mixer");
  const [search,setSearch]=useState("");
  const [recording,setRecording]=useState(false);
  const [recordStart,setRecordStart]=useState(0);
  const [recordSeconds,setRecordSeconds]=useState(0);
  const [dragging,setDragging]=useState(false);
  const [importing,setImporting]=useState(false);
  const [settingsOpen,setSettingsOpen]=useState(false);
  const [mobileNav,setMobileNav]=useState(false);
  const [toast,setToast]=useState("");
  useEffect(()=>{tracksRef.current=tracks;},[tracks]);
  useEffect(()=>{decksRef.current=decks;},[decks]);

  const notify=useCallback((message:string)=>{
    setToast(message);
    window.setTimeout(()=>setToast(current=>current===message?"":current),4500);
  },[]);
  const updateDeck=useCallback((id:DeckId,patch:Partial<DeckState>)=>{
    setDecks(prev=>({...prev,[id]:{...prev[id],...patch}}));
  },[]);

  useEffect(()=>{
    let alive=true;
    try {
      engine.current=new DJEngine();
      (["A","B"] as const).forEach(id=>{
        const media=engine.current!.getMedia(id);
        media.addEventListener("ended",()=>{if(alive)updateDeck(id,{playing:false});});
        media.addEventListener("pause",()=>{if(alive)updateDeck(id,{playing:false});});
        media.addEventListener("play",()=>{if(alive)updateDeck(id,{playing:true});});
      });
    } catch { window.setTimeout(()=>{if(alive)notify("Tu navegador no admite Web Audio. Prueba Chrome, Edge o Safari reciente.");},100); }
    loadTracks().then(items=>{
      if(!alive)return;
      setTracks(items.sort((a,b)=>b.addedAt-a.addedAt).map(item=>({...item,url:URL.createObjectURL(item.blob)})));
    }).catch(()=>{if(alive)notify("La biblioteca local no está disponible; puedes seguir mezclando durante esta sesión.");});
    loadMixes().then(items=>{if(alive)setMixes(items.sort((a,b)=>b.createdAt-a.createdAt));}).catch(()=>{});
    const timer=window.setInterval(()=>{
      const current=engine.current;
      if(!current)return;
      setDecks(prev=>{
        let changed=false;
        const next={...prev};
        (["A","B"] as const).forEach(id=>{
          const d=prev[id];if(!d.trackId)return;
          const media=current.getMedia(id);
          const dur=Number.isFinite(media.duration)?media.duration:d.duration;
          if(d.loopEnd!==null&&d.loopStart!==null&&media.currentTime>=d.loopEnd){
            current.seek(id,d.loopStart);
          }
          const pos=media.currentTime||0;
          const playing=!media.paused&&!media.ended;
          if(Math.abs(d.position-pos)>0.06||d.playing!==playing||Math.abs(d.duration-dur)>0.2){
            next[id]={...d,position:pos,playing,duration:dur};changed=true;
          }
        });
        return changed?next:prev;
      });
    },100);
    return ()=>{
      alive=false;window.clearInterval(timer);
      engine.current?.destroy();engine.current=null;
      tracksRef.current.forEach(t=>URL.revokeObjectURL(t.url));
    };
  },[notify,updateDeck]);

  useEffect(()=>{
    if(!recording)return;
    const tick=window.setInterval(()=>setRecordSeconds(Math.floor((Date.now()-recordStart)/1000)),250);
    return ()=>window.clearInterval(tick);
  },[recording,recordStart]);

  const aTrack=useMemo(()=>tracks.find(t=>t.id===decks.A.trackId),[tracks,decks.A.trackId]);
  const bTrack=useMemo(()=>tracks.find(t=>t.id===decks.B.trackId),[tracks,decks.B.trackId]);
  const filtered=useMemo(()=>tracks.filter(t=>(t.title+" "+t.artist+" "+t.fileName).toLowerCase().includes(search.trim().toLowerCase())),[tracks,search]);

  function loadToDeck(id:DeckId,track:Track){
    if(!engine.current){notify("Audio no disponible");return;}
    engine.current.load(id,track.url);
    engine.current.setVolume(id,0.82);
    engine.current.setRate(id,1);
    (["high","mid","low"] as const).forEach(band=>engine.current?.setEQ(id,band,0));
    engine.current.setEffect(id,"off",0.45);
    updateDeck(id,{...makeDeck(),trackId:track.id,duration:track.duration});
    setActiveDeck(id);
    notify(track.title+" cargada en Deck "+id);
  }
  async function importFiles(files:File[]){
    const valid=files.filter(file=>/^audio\//.test(file.type)||/\.(mp3|wav|m4a|ogg|flac|aac)$/i.test(file.name));
    if(!valid.length){notify("Selecciona archivos de audio compatibles.");return;}
    setImporting(true);
    let next:DeckId|null=!decksRef.current.A.trackId?"A":!decksRef.current.B.trackId?"B":null;
    for(const file of valid){
      if(file.size>150*1024*1024){notify(file.name+" supera 150 MB.");continue;}
      try{
        const meta=inferName(file.name);
        let analysis:{duration:number;peaks:number[];bpm:number|null}={duration:0,peaks:[],bpm:null};
        try{analysis=await analyzeFile(file);}catch{ /* Browser may play a format that OfflineAudioContext cannot decode. */ }
        const stored={id:crypto.randomUUID(),...meta,blob:file,fileName:file.name,addedAt:Date.now(),...analysis};
        const track:Track={...stored,url:URL.createObjectURL(file)};
        setTracks(prev=>[track,...prev]);
        try{await saveTrack(stored);}catch{notify("Almacenamiento local lleno: la pista está disponible solo en esta sesión.");}
        if(next){
          loadToDeck(next,track);
          next=next==="A"?"B":null;
        }
      }catch{notify("No pude abrir "+file.name);}
    }
    setImporting(false);setDragging(false);
  }
  async function togglePlay(id:DeckId){
    const current=engine.current;if(!current)return;
    try {
      if(current.getMedia(id).paused)await current.play(id);
      else current.pause(id);
    }catch{notify("No se pudo reproducir esta pista.");}
  }
  function cue(id:DeckId){
    const d=decksRef.current[id];const current=engine.current;
    if(!current||!d.trackId)return;
    if(d.playing){current.pause(id);current.seek(id,d.cue);}
    else if(Math.abs(d.position-d.cue)<0.15){updateDeck(id,{cue:d.position});}
    else current.seek(id,d.cue);
  }
  function pad(id:DeckId,index:number){
    const d=decksRef.current[id];if(!d.trackId)return;
    const cues=[...d.hotCues];
    if(cues[index]===null){cues[index]=d.position;updateDeck(id,{hotCues:cues});notify("Hot cue "+(index+1)+" guardado");}
    else engine.current?.seek(id,cues[index]!);
  }
  function toggleLoop(id:DeckId){
    const d=decksRef.current[id];if(!d.trackId)return;
    if(d.loopEnd!==null){updateDeck(id,{loopEnd:null,loopStart:null});return;}
    const track=tracksRef.current.find(t=>t.id===d.trackId);
    const beats=track?.bpm?d.loopBeats*60/(track.bpm*d.rate):d.loopBeats*0.5;
    updateDeck(id,{loopStart:d.position,loopEnd:Math.min(d.duration,d.position+beats)});
  }
  function setLoopBeats(id:DeckId,beats:4|8|16){
    const d=decksRef.current[id];
    const patch:Partial<DeckState>={loopBeats:beats};
    if(d.loopStart!==null&&d.loopEnd!==null){
      const track=tracksRef.current.find(t=>t.id===d.trackId);
      const seconds=track?.bpm?beats*60/(track.bpm*d.rate):beats*0.5;
      patch.loopEnd=Math.min(d.duration,d.loopStart+seconds);
    }
    updateDeck(id,patch);
  }
  function setRate(id:DeckId,n:number){engine.current?.setRate(id,n);updateDeck(id,{rate:n});}
  function sync(id:DeckId){
    const other=id==="A"?"B":"A";
    const d=decksRef.current[id];const o=decksRef.current[other];
    const ownTrack=tracksRef.current.find(t=>t.id===d.trackId);
    const otherTrack=tracksRef.current.find(t=>t.id===o.trackId);
    if(!ownTrack?.bpm||!otherTrack?.bpm){notify("SYNC requiere que ambas pistas tengan un BPM estimado.");return;}
    const rate=Math.min(1.25,Math.max(0.75,otherTrack.bpm*o.rate/ownTrack.bpm));
    setRate(id,rate);
    notify("Tempo sincronizado. La fase de los beats requiere ajuste manual.");
  }
  function eq(id:DeckId,band:"high"|"mid"|"low",n:number){
    engine.current?.setEQ(id,band,n);
    setDecks(prev=>({...prev,[id]:{...prev[id],eq:{...prev[id].eq,[band]:n}}}));
  }
  function fx(id:DeckId,effect:EffectName,amount?:number){
    const d=decksRef.current[id];
    const actualAmount=amount??d.fxAmount;
    engine.current?.setEffect(id,effect,actualAmount);
    updateDeck(id,{fx:effect,fxAmount:actualAmount});
  }
  function volume(id:DeckId,n:number){engine.current?.setVolume(id,n);updateDeck(id,{volume:n});}
  function crossfade(n:number){engine.current?.setCrossfader(n);setCross(n);}

  function toggleRecord(){
    const current=engine.current;if(!current)return;
    if(current.recording){current.stopRecording();setRecording(false);notify("Grabación detenida. Guardando mezcla…");return;}
    try{
      current.startRecording(async(blob,mime,duration)=>{
        if(!blob.size){notify("La grabación terminó sin audio.");return;}
        const id=crypto.randomUUID();
        const date=new Date();
        const title="Open DJ Mix · "+date.toLocaleString("es-CO",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"});
        const item:StoredMix={id,title,blob,format:mime,duration,createdAt:Date.now()};
        setMixes(prev=>[item,...prev]);
        try{await saveMix(item);}catch{notify("No hubo espacio para guardar la grabación; descárgala ahora.");}
        notify("Mezcla grabada. Disponible en Grabaciones.");
      });
      setRecordStart(Date.now());setRecordSeconds(0);setRecording(true);
    }catch(e){notify(e instanceof Error?e.message:"No se pudo iniciar la grabación.");}
  }
  async function deleteTrack(id:string){
    if(decksRef.current.A.trackId===id||decksRef.current.B.trackId===id){
      (["A","B"] as const).forEach(deckId=>{
        if(decksRef.current[deckId].trackId===id){
          const media=engine.current?.getMedia(deckId);
          media?.pause();media?.removeAttribute("src");media?.load();
          updateDeck(deckId,makeDeck());
        }
      });
    }
    setTracks(prev=>{const removed=prev.find(t=>t.id===id);if(removed)URL.revokeObjectURL(removed.url);return prev.filter(t=>t.id!==id);});
    try{await removeTrack(id);}catch{}
  }
  async function deleteMix(id:string){setMixes(prev=>prev.filter(m=>m.id!==id));try{await removeMix(id);}catch{}}
  function exportMix(mix:StoredMix){
    const ext=mix.format.includes("mp4")?"m4a":mix.format.includes("webm")?"webm":"audio";
    downloadFile(mix.blob,mix.title.replace(/[^a-z0-9 _-]/gi,"").replace(/\s+/g,"_")+"."+ext);
  }
  function nav(name:string,target:string){
    setActiveNav(name);setMobileNav(false);
    if(target==="upload"){inputRef.current?.click();return;}
    if(target==="settings"){setSettingsOpen(true);return;}
    document.getElementById(target)?.scrollIntoView({behavior:"smooth",block:"nearest"});
  }
  const activeState=decks[activeDeck];

  return <div className="app-shell" onDragOver={e=>{if(e.dataTransfer.types.includes("Files")){e.preventDefault();setDragging(true);}}}
    onDrop={e=>{if(e.dataTransfer.files.length){e.preventDefault();void importFiles(Array.from(e.dataTransfer.files));}}}
    onDragLeave={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node))setDragging(false);}}>
    <input ref={inputRef} type="file" accept="audio/*,.mp3,.wav,.m4a,.ogg,.flac,.aac" multiple className="visually-hidden"
      onChange={e=>{void importFiles(Array.from(e.currentTarget.files||[]));e.currentTarget.value="";}}/>
    {dragging&&<div className="drag-overlay"><UploadCloud size={46}/><strong>Suelta tus canciones aquí</strong><span>MP3, WAV, M4A u OGG</span></div>}
    <header className="topbar">
      <button className="mobile-menu icon-btn" onClick={()=>setMobileNav(!mobileNav)} aria-label="Abrir menú"><Menu size={20}/></button>
      <div className="brand"><div className="brand-mark"><i/><i/><i/><i/><i/></div><strong>Open DJ</strong><span>STUDIO</span></div>
      <label className="search-box"><Search size={17}/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Buscar canciones, artistas o archivos…"/><span className="search-shortcut">LIBRARY</span></label>
      <div className="topbar-right"><span className="live-label"><i/> MOTOR ACTIVO</span>
        <button className={"btn btn-subtle "+(recording?"recording":"")} onClick={toggleRecord}><span className="rec-dot"/>{recording?"Detener · "+formatTime(recordSeconds):"Grabar"}</button>
        <button className="btn btn-primary" onClick={()=>nav("Grabaciones","recordings")}><Download size={16}/>Mis mezclas</button>
        <button className="icon-btn settings-trigger" onClick={()=>setSettingsOpen(true)} aria-label="Configuración"><Settings2 size={19}/></button>
      </div>
    </header>
    <div className="workspace">
      <aside className={"sidebar "+(mobileNav?"show":"")}>
        <div className="sidebar-section-title">WORKSPACE</div>
        <nav aria-label="Navegación principal">{NAV.map(item=><button key={item.name} className={"sidebar-link "+(activeNav===item.name?"active":"")} onClick={()=>nav(item.name,item.target)}>
          <item.icon size={19} strokeWidth={1.8}/><span>{item.name}</span>{item.name==="Biblioteca"&&<small>{tracks.length}</small>}</button>)}</nav>
        <div className="sidebar-footer"><div className="sidebar-footer-icon"><Headphones size={21}/></div><div><strong>Tu estudio, tus archivos.</strong><span>Mezcla privada en tu navegador.</span></div></div>
      </aside>
      <main className="main-content" id="mixer">
        <div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-dot"/> LIVE WORKSPACE <span> / </span> TWO-DECK MIXER</div><h1>DJ mixer <span className="heading-light">/ studio</span></h1><p>Mezcla, experimenta y graba tus sesiones en tiempo real.</p></div>
          <div className="page-heading-stat"><span>ESTADO DE AUDIO</span><strong><span className="status-indicator"/>{recording?"Grabando sesión":"Listo para mezclar"}</strong></div></div>
        <div className="dashboard-grid">
          <div className="center-content">
            <div className="deck-displays">
              <DeckDisplay id="A" deck={decks.A} track={aTrack} selected={activeDeck==="A"} onSelect={()=>setActiveDeck("A")}
                onPlay={()=>void togglePlay("A")} onCue={()=>cue("A")} onSync={()=>sync("A")}
                onLoop={()=>toggleLoop("A")} onSeek={n=>engine.current?.seek("A",n)} onUpload={()=>inputRef.current?.click()}/>
              <DeckDisplay id="B" deck={decks.B} track={bTrack} selected={activeDeck==="B"} onSelect={()=>setActiveDeck("B")}
                onPlay={()=>void togglePlay("B")} onCue={()=>cue("B")} onSync={()=>sync("B")}
                onLoop={()=>toggleLoop("B")} onSeek={n=>engine.current?.seek("B",n)} onUpload={()=>inputRef.current?.click()}/>
            </div>
            <div className="console-title-row"><div><Disc3 size={17}/><strong>Performance controller</strong><span>2 channels · 3-band EQ · 8 hot pads</span></div><small>INTERACTIVE DECK</small></div>
            <DJController a={decks.A} b={decks.B} hasA={!!aTrack} hasB={!!bTrack} cross={cross}
              onCross={crossfade} onPlay={id=>void togglePlay(id)} onCue={cue} onSync={sync}
              onNudge={(id,n)=>engine.current?.seek(id,decksRef.current[id].position+n)} onPad={pad}
              onLoop={toggleLoop} onLoopBeats={setLoopBeats} onRate={setRate} onEQ={eq} onVol={volume}
              onFX={(id,n)=>fx(id,decksRef.current[id].fx,n)}/>
            <div className="bottom-grid">
              <section className="panel library-panel" id="library"><div className="panel-heading"><div><Music2 size={18}/><h3>Biblioteca musical</h3><span className="count">{tracks.length}</span></div><button className="text-action" onClick={()=>inputRef.current?.click()}><Plus size={15}/>Añadir</button></div>
                <div className="table-scroll"><table className="tracks-table"><thead><tr><th>TÍTULO</th><th>BPM</th><th>DURACIÓN</th><th>DECK A</th><th>DECK B</th><th/></tr></thead>
                  <tbody>{filtered.map(t=><tr key={t.id} onDoubleClick={()=>loadToDeck(activeDeck,t)}>
                    <td><div className="table-track"><div className="tiny-art"><Music2 size={15}/></div><div><strong title={t.title}>{t.title}</strong><small>{t.artist}</small></div></div></td>
                    <td className="numeric">{t.bpm??"—"}</td><td className="numeric">{formatTime(t.duration)}</td>
                    <td><button className={"deck-load-pill "+(decks.A.trackId===t.id?"is-loaded":"")} onClick={()=>loadToDeck("A",t)} aria-label={"Cargar "+t.title+" en A"}>{decks.A.trackId===t.id?"● A":"A"}</button></td>
                    <td><button className={"deck-load-pill "+(decks.B.trackId===t.id?"is-loaded":"")} onClick={()=>loadToDeck("B",t)} aria-label={"Cargar "+t.title+" en B"}>{decks.B.trackId===t.id?"● B":"B"}</button></td>
                    <td><button className="icon-btn danger-ghost" title="Eliminar de la biblioteca" aria-label={"Eliminar "+t.title} onClick={()=>void deleteTrack(t.id)}><X size={14}/></button></td>
                  </tr>)}</tbody></table>
                  {!filtered.length&&<div className="table-empty"><FileAudio2 size={27}/><strong>{tracks.length?"Sin coincidencias":"Todavía no hay canciones"}</strong><span>{tracks.length?"Cambia el texto de búsqueda.":"Sube archivos MP3 para comenzar tu sesión."}</span>{!tracks.length&&<button className="btn btn-primary" onClick={()=>inputRef.current?.click()}><Plus size={15}/>Subir canción</button>}</div>}
                </div></section>
              <section className="panel mixes-panel" id="recordings"><div className="panel-heading"><div><Mic2 size={18}/><h3>Mis grabaciones</h3><span className="count">{mixes.length}</span></div><span className="panel-caption">GUARDADO LOCAL</span></div>
                <div className="mixes-list">{mixes.slice(0,5).map(m=><div className="mix-item" key={m.id}><div className="mix-icon"><AudioLines size={18}/></div><div><strong>{m.title}</strong><small>{formatTime(m.duration)} · {m.format.includes("mp4")?"M4A":"WebM"} · {new Date(m.createdAt).toLocaleDateString("es-CO")}</small></div><button className="icon-btn" onClick={()=>exportMix(m)} aria-label="Descargar mezcla"><Download size={17}/></button><button className="icon-btn danger-ghost" onClick={()=>void deleteMix(m.id)} aria-label="Eliminar grabación"><Trash2 size={16}/></button></div>)}
                  {!mixes.length&&<div className="mix-empty"><Radio size={23}/><strong>El escenario es tuyo</strong><span>Pulsa «Grabar» y tu próxima mezcla aparecerá aquí.</span></div>}
                </div></section>
            </div>
          </div>
          <aside className="right-rail">
            <section className="upload-panel" id="upload" onClick={()=>inputRef.current?.click()} onDragOver={e=>e.preventDefault()}>
              <div className="upload-icon"><UploadCloud size={27}/></div><strong>{importing?"Analizando archivos…":"Subir música"}</strong><p>Arrastra tus canciones MP3 aquí<br/>o selecciónalas desde tu equipo.</p>
              <span className="btn btn-subtle"><FolderOpen size={15}/>Seleccionar archivos</span><small>MP3, WAV, M4A, OGG · Máx. 150 MB</small>
            </section>
            <section className="panel queue-panel"><div className="panel-heading"><div><Library size={18}/><h3>Cola de canciones</h3><span className="count">{tracks.length}</span></div></div>
              <div className="queue-list">{tracks.slice(0,6).map((t,i)=><div className="queue-item" key={t.id}><span className="queue-num">{String(i+1).padStart(2,"0")}</span><div className="queue-art"><Music2 size={16}/></div><div className="queue-info"><strong title={t.title}>{t.title}</strong><span>{t.artist} · {formatTime(t.duration)}</span></div><button onClick={()=>loadToDeck(activeDeck,t)} className="icon-btn queue-play" title={"Cargar en deck "+activeDeck}><Play size={15}/></button></div>)}
                {!tracks.length&&<div className="queue-empty"><Disc3 size={21}/><span>Tu cola está vacía.</span><small>Las canciones que subas aparecerán aquí.</small></div>}
              </div></section>
            <section className="panel effects-panel" id="effects"><div className="panel-heading"><div><Activity size={18}/><h3>Efectos de audio</h3></div><span className="panel-caption">FX</span></div>
              <div className="fx-deck-tabs"><button className={activeDeck==="A"?"active":""} onClick={()=>setActiveDeck("A")}>Deck A</button><button className={activeDeck==="B"?"active":""} onClick={()=>setActiveDeck("B")}>Deck B</button></div>
              <div className="effects-grid">{EFFECTS.map(fxPreset=><button key={fxPreset.id} title={fxPreset.description} onClick={()=>fx(activeDeck,fxPreset.id)}
                className={"effect-button "+(activeState.fx===fxPreset.id?"active":"")}><fxPreset.icon size={20}/><span>{fxPreset.label}</span></button>)}</div>
              <div className="fx-amount"><div><span>Intensidad del efecto</span><strong>{Math.round(activeState.fxAmount*100)}%</strong></div><input type="range" min={0} max={1} step={0.01} value={activeState.fxAmount} onChange={e=>fx(activeDeck,activeState.fx,Number(e.target.value))}/></div>
            </section>
            <section className="panel export-panel"><div className="panel-heading"><div><Radio size={18}/><h3>Grabar y exportar</h3></div></div>
              <div className="export-detail"><span>Fuente de audio</span><strong>Salida master (A + B)</strong></div>
              <div className="export-detail"><span>Formato de grabación</span><strong>WebM / M4A <CircleHelp size={13} aria-label="Según el navegador"/></strong></div>
              <div className="export-detail"><span>Grabación</span><strong className={recording?"recording-text":""}>{recording?"● "+formatTime(recordSeconds):"● Inactiva"}</strong></div>
              <button className={"btn full-width "+(recording?"btn-recording":"btn-primary")} onClick={toggleRecord}>{recording?<Pause size={17}/>:<Radio size={17}/>} {recording?"Finalizar grabación":"Iniciar grabación"}</button>
              <p className="export-note">Se captura el audio combinado de los dos decks, directamente en tu navegador.</p>
            </section>
            <div className="rail-hint"><Headphones size={16}/><span>Consejo: selecciona A o B en la biblioteca para cargar una canción. Los jog wheels permiten ajustar su posición.</span></div>
          </aside>
        </div>
        <footer className="app-footer"><span>OPEN DJ STUDIO</span><span>Powered by Web Audio API · Local-first</span><span>v0.1.0</span></footer>
      </main>
    </div>
    {toast&&<div className="toast" role="status"><Check size={17}/>{toast}<button onClick={()=>setToast("")} aria-label="Cerrar"><X size={14}/></button></div>}
    {settingsOpen&&<div className="modal-backdrop" onClick={()=>setSettingsOpen(false)}><div className="settings-modal panel" role="dialog" aria-modal="true" aria-label="Ajustes de audio" onClick={e=>e.stopPropagation()}>
      <div className="modal-head"><div><Settings2 size={20}/><h2>Configuración</h2></div><button className="icon-btn" onClick={()=>setSettingsOpen(false)} aria-label="Cerrar"><X size={19}/></button></div>
      <p>Ajusta el volumen de salida y administra los archivos almacenados en este navegador.</p>
      <label className="settings-control"><span><Volume2 size={17}/>Volumen master <strong>{Math.round(master*100)}%</strong></span><input type="range" min={0} max={1} step={0.01} value={master} onChange={e=>{const n=Number(e.target.value);setMaster(n);engine.current?.setMaster(n);}}/></label>
      <div className="settings-info"><FileAudio2 size={18}/><span>{tracks.length} pistas almacenadas localmente · No se suben a ningún servidor.</span></div>
      <button className="btn btn-danger" onClick={async()=>{if(!window.confirm("¿Eliminar todas las canciones guardadas?"))return;for(const t of tracksRef.current)URL.revokeObjectURL(t.url);setTracks([]);(["A","B"] as const).forEach(id=>{const media=engine.current?.getMedia(id);media?.pause();media?.removeAttribute("src");media?.load();updateDeck(id,makeDeck());});await clearTracks().catch(()=>{});notify("Biblioteca vaciada");setSettingsOpen(false);}}><Trash2 size={16}/>Vaciar biblioteca</button>
    </div></div>}
  </div>;
}
