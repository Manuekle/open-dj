"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { gsap, useGSAP } from "@/lib/gsap";
import { cn } from "@/lib/sodium/utils";
import { formatTime } from "@/lib/types";
import { useDJ } from "@/hooks/use-dj";
import { useProjects } from "@/hooks/use-projects";
import { ProjectBar } from "@/components/project-bar";
import { DeckCard } from "@/components/deck-card";
import { Console } from "@/components/console";
import { Studio } from "@/components/studio";
import { TransitionPanel } from "@/components/transition-editor";
import { mixMarks } from "@/components/automix/model";
import { LyricsFollow } from "@/components/lyrics/lyrics-follow";
import { AutoMixPanel } from "@/components/automix/automix-panel";
import { useAutoMixPanelProps } from "@/components/automix/use-panel-props";
import { TrackEditor } from "@/components/track-editor";
import { Recordings, TrackLibrary } from "@/components/library";
import { Hint } from "@/components/hint";
import { SHORTCUT_GROUPS, useShortcuts } from "@/hooks/use-shortcuts";
import { useInputModality } from "@/hooks/use-input-modality";
import { Button } from "@/components/sodium/ui/button";
import { Input } from "@/components/sodium/ui/input";
import { Status } from "@/components/sodium/ui/status";
import { Slider } from "@/components/sodium/ui/slider";
import { Field, FieldLabel } from "@/components/sodium/ui/field";
import { Dialog, DialogAction, DialogBody, DialogClose, DialogConfirmField, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/sodium/ui/dialog";
import { Kbd } from "@/components/sodium/ui/kbd";
import { TooltipProvider } from "@/components/sodium/ui/tooltip";
import { AppMark } from "@/components/app-mark";
import { Digits, IconSwap, TextSwap, usePresence } from "@/components/motion";
import { CloudUpload, Icon, Keyboard, Record, Settings, Stop } from "@/components/sodium/icon";

export function DJApp() {
  const fileInput = useRef<HTMLInputElement>(null);
  const dropLayer = useRef<HTMLDivElement>(null);
  const dj = useDJ(fileInput);
  const projects = useProjects(dj);
  const [search, setSearch] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [link, setLink] = useState({ url: "", start: "", end: "" });
  const submitLink = async () => { if (await dj.importUrl(link.url, link.start, link.end)) { setLinkOpen(false); setLink({ url: "", start: "", end: "" }); } };
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const drop = usePresence(dragging);
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = dj.tracks.find(t => t.id === editingId) ?? null;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return projects.tracks.filter(t => `${t.title} ${t.artist} ${t.fileName}`.toLowerCase().includes(q));
  }, [projects.tracks, search]);
  const live = dj.decks.A.playing || dj.decks.B.playing;
  // The lyrics follow the deck that is heard: the one playing, else the one the crossfader favours, else the one with a track.
  const followDeck = dj.decks.A.playing !== dj.decks.B.playing ? (dj.decks.A.playing ? "A" : "B")
    : dj.decks.A.playing ? (dj.cross <= 0 ? "A" : "B") : dj.trackA || !dj.trackB ? "A" : "B";
  // What the waveforms mark: the running mix, else the transition AutoMix will run next, else the plan between the decks.
  const shown = dj.transition?.plan ?? (dj.auto.enabled ? dj.auto.plan : null) ?? dj.plan;
  const byId = useMemo(() => new Map(dj.tracks.map(t => [t.id, t])), [dj.tracks]);
  const automix = useAutoMixPanelProps(dj, projects.tracks);
  // How many times each track sits in the play queue, so the library can say it and offer to add one more.
  const queued = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const item of dj.auto.queue.items) counts[item.trackId] = (counts[item.trackId] ?? 0) + 1;
    return counts;
  }, [dj.auto.queue.items]);
  const lite = automix.decks;
  // The mix-out stretch on the outgoing track and the mix-in stretch on the incoming one, at the rate the engine plays them.
  const marks = useMemo(() => mixMarks(shown, byId, lite), [shown, byId, lite]);
  const marksFor = (id: "A" | "B") => {
    const trackId = dj.decks[id].trackId;
    if (!marks || !trackId) return {};
    if (trackId === marks.fromId) return { out: marks.out };
    if (trackId === marks.toId) return { in: marks.in };
    return {};
  };

  useShortcuts(dj, () => setShortcutsOpen(true));
  useInputModality();

  useGSAP(() => {
    gsap.to(dropLayer.current, { autoAlpha: dragging ? 1 : 0, duration: dragging ? 0.2 : 0.15, ease: "power2.out" });
  }, { dependencies: [dragging] });

  return <TooltipProvider><div className="min-h-dvh bg-page text-text-1"
    onDragOver={e => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragging(true); } }}
    onDrop={e => { if (e.dataTransfer.files.length) { e.preventDefault(); setDragging(false); void dj.importFiles(Array.from(e.dataTransfer.files)); } }}
    onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}>
    <div className="sr-only" aria-hidden>
      <Input ref={fileInput} type="file" accept="audio/*,.mp3,.wav,.m4a,.ogg,.flac,.aac" multiple tabIndex={-1} aria-label="Audio files"
        onChange={e => { void dj.importFiles(Array.from(e.currentTarget.files || [])); e.currentTarget.value = ""; }}/>
    </div>

    <a href="#controller" className="sr-only focus:not-sr-only focus:fixed focus:start-2 focus:top-2 focus:z-(--z-overlay) focus:bg-panel focus:p-2 type-label">Skip to the controller</a>

    {/* One ruled row of cells: the mark and name, the search, where the session stands, then its actions. It scrolls
        with the page and sits inset like the cards below. Below lg the search drops to its own row. */}
    <div className="px-4 pt-4">
    <header className="flex flex-wrap items-stretch border border-line bg-panel lg:h-12 lg:flex-nowrap">
      <div className="flex h-12 shrink-0 items-center gap-2.5 border-e border-line ps-4 pe-5">
        <AppMark className="size-5 text-accent-text"/>
        <h1 className="type-heading-sm">Shift</h1>
      </div>
      <ProjectBar projects={projects}/>
      <div className="order-last flex w-full items-center border-t border-line px-3 py-2 lg:order-none lg:w-auto lg:min-w-0 lg:flex-1 lg:border-t-0 lg:py-0">
        <Input mode="search" value={search} onValueChange={setSearch} placeholder="Search the library" aria-label="Search the library" shortcut="/" className="lg:max-w-md"/>
      </div>
      <div className="ms-auto flex h-12 shrink-0 items-center gap-3 border-s border-line px-4 lg:ms-0">
        <Status size="sm" status={dj.recording || live ? "running" : "idle"}><TextSwap>{dj.recording ? "Recording" : live ? "Live" : "Ready"}</TextSwap></Status>
        {dj.recording && <Digits value={formatTime(dj.recordSeconds)} className="type-code-sm text-text-1"/>}
      </div>
      <div className="flex h-12 items-center gap-2 border-s border-line px-3">
        <Hint label={dj.recording ? "Stop and save the recording" : "Record the master output"}>
          <Button variant={dj.recording ? "destructive" : "secondary"} size="sm" onClick={dj.toggleRecord} aria-pressed={dj.recording}
            aria-label={dj.recording ? "Stop recording" : "Record mix"}>
            <IconSwap active={dj.recording} from={Record} to={Stop}/>
            <span className="hidden sm:inline"><TextSwap>{dj.recording ? "Stop" : "Record"}</TextSwap></span>
          </Button>
        </Hint>
        <Hint label="Play any track as a rhythm game">
          <Link href="/play" className="inline-flex h-(--control-sm) items-center px-2.5 type-label-sm text-text-2 hover:text-text-1">Rhythm</Link>
        </Hint>
        <Hint label="See each track's stems on their own lanes">
          <Link href="/stems" className="inline-flex h-(--control-sm) items-center px-2.5 type-label-sm text-text-2 hover:text-text-1">Stems</Link>
        </Hint>
        <Hint label="Sing along: lyrics with timing, from Whisper">
          <Link href="/lyrics" className="inline-flex h-(--control-sm) items-center px-2.5 type-label-sm text-text-2 hover:text-text-1">Karaoke</Link>
        </Hint>
        <Hint label="Record your voice over stems, with autotune">
          <Link href="/studio" className="inline-flex h-(--control-sm) items-center px-2.5 type-label-sm text-text-2 hover:text-text-1">Studio</Link>
        </Hint>
        <Hint label="Keyboard shortcuts" keys="?">
          <Button variant="ghost" size="icon-sm" onClick={() => setShortcutsOpen(true)} aria-label="Keyboard shortcuts"><Icon icon={Keyboard}/></Button>
        </Hint>
        <Hint label="Settings">
          <Button variant="ghost" size="icon-sm" onClick={() => setSettingsOpen(true)} aria-label="Open settings"><Icon icon={Settings}/></Button>
        </Hint>
      </div>
    </header>
    </div>

    {/* What changes out of sight, said once: a deck starting or stopping, a mix, a recording. */}
    <div className="sr-only" role="status" aria-live="polite">
      <span>{dj.decks.A.playing ? "Deck 1 playing." : dj.trackA ? "Deck 1 cued." : ""}</span>
      <span>{dj.decks.B.playing ? "Deck 2 playing." : dj.trackB ? "Deck 2 cued." : ""}</span>
      <span>{dj.transition ? "Mix started." : ""}</span>
      <span>{dj.recording ? "Recording started." : ""}</span>
    </div>

    <main className="flex flex-col gap-4 p-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {(["A", "B"] as const).map(id => <DeckCard key={id} id={id} deck={dj.decks[id]} track={id === "A" ? dj.trackA : dj.trackB}
          selected={dj.activeDeck === id} marks={marksFor(id)} onSelect={() => dj.setActiveDeck(id)} onPlay={() => void dj.togglePlay(id)}
          onSkip={n => dj.skipBeats(id, n)} onSync={() => dj.sync(id)} onLoop={() => dj.decks[id].loopEnd !== null ? dj.toggleLoop(id) : dj.beatLoop(id, 4)}
          onSeek={n => dj.seek(id, n)} onVolume={n => dj.volume(id, n)} onBrowse={() => dj.browse(id)}
          library={projects.tracks} onLoadTrack={trackId => { const t = byId.get(trackId); if (t) dj.loadToDeck(id, t); }}
          silent={dj.silent[id]} onHear={() => dj.makeHeard(id)} positions={dj.positions}/>)}
      </div>

      <LyricsFollow dj={dj} deck={followDeck} track={followDeck === "A" ? dj.trackA : dj.trackB}/>

      <AutoMixPanel {...automix.props}/>

      <TransitionPanel dj={dj}/>

      <Console dj={dj} onShortcuts={() => setShortcutsOpen(true)}/>

      <Studio dj={dj}/>

      {/* Both regions stretch to the row, so neither leaves a hole under the shorter one. */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <TrackLibrary tracks={filtered} total={projects.tracks.length} search={search} loaded={{ A: dj.decks.A.trackId, B: dj.decks.B.trackId }}
          selected={dj.selectedTrackId} activeDeck={dj.activeDeck} importing={dj.importing} className="min-w-0 xl:col-span-2"
          onSelect={dj.setSelectedTrackId} onLoad={dj.loadToDeck} onDelete={id => void projects.removeTrack(id)} onEdit={setEditingId} onAdd={() => dj.browse()} onAddLink={() => setLinkOpen(true)}
          onQueue={id => dj.queue.add([id])} onQueueAll={() => dj.queue.add(filtered.map(t => t.id))} queued={queued}
          stemsAvailable={dj.stemsAvailable} splitting={dj.splitting} onSplit={id => void dj.splitStems(id)}
          lyricsAvailable={dj.lyricsAvailable} transcribing={dj.transcribing} onTranscribe={id => void dj.transcribeLyrics(id)}/>
        <Recordings mixes={dj.mixes} recording={dj.recording} recordSeconds={dj.recordSeconds} mixName={dj.mixName} onMixName={dj.setMixName}
          onRecord={dj.toggleRecord} onExport={dj.exportMix} onDelete={id => void projects.removeMix(id)}/>
      </div>
    </main>

    <div ref={dropLayer} aria-hidden={!dragging} className="pointer-events-none invisible fixed inset-0 z-(--z-overlay) grid place-items-center bg-scrim opacity-0">
      <div className={cn("t-modal overlay flex flex-col items-center gap-2 p-8", drop)}>
        <Icon icon={CloudUpload} size={32}/>
        <p className="type-heading-sm">Drop to add tracks</p>
        <p className="type-body-sm text-text-2">MP3, WAV, M4A or OGG</p>
      </div>
    </div>

    <TrackEditor track={editing} onClose={() => setEditingId(null)} onSave={dj.updateTrack}/>

    <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
      <DialogContent size="sm">
        <DialogHeader><DialogTitle>Settings</DialogTitle></DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-4">
            <DialogDescription>{dj.tracks.length} tracks are stored in this browser. {projects.backup
              ? "Projects and their tracks are also backed up to disk on the machine running this app, so they survive a cleared browser."
              : "No disk backup is running, so the projects live in this browser only."} Nothing leaves that machine: AI transitions run on a local model through Ollama.</DialogDescription>
            <Field>
              <FieldLabel>Master volume</FieldLabel>
              <Slider min={0} max={100} value={Math.round(dj.master * 100)} onValueChange={v => dj.setMaster((Array.isArray(v) ? v[0] : v) / 100)}
                format={{ style: "unit", unit: "percent" }} showValue/>
            </Field>
          </div>
        </DialogBody>
        <DialogFooter>
          <DialogClose>Done</DialogClose>
          <Button variant="destructive" disabled={!dj.tracks.length} onClick={() => { setSettingsOpen(false); setClearOpen(true); }}>Clear library</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={linkOpen} onOpenChange={setLinkOpen}>
      <DialogContent size="sm">
        <DialogHeader><DialogTitle>Import from a link</DialogTitle></DialogHeader>
        <DialogBody>
          <form id="import-link" className="flex flex-col gap-4" onSubmit={e => { e.preventDefault(); void submitLink(); }}>
            <DialogDescription>The machine running this app downloads the audio with yt-dlp and ffmpeg. Use only audio you have the right to copy: public domain, Creative Commons or your own.</DialogDescription>
            <Field><FieldLabel>Link</FieldLabel>
              <Input type="url" required placeholder="https://www.youtube.com/watch?v=…" value={link.url} onChange={e => setLink({ ...link, url: e.currentTarget.value })}/></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field><FieldLabel>Start (optional)</FieldLabel><Input placeholder="9:51" value={link.start} onChange={e => setLink({ ...link, start: e.currentTarget.value })}/></Field>
              <Field><FieldLabel>End (optional)</FieldLabel><Input placeholder="14:04" value={link.end} onChange={e => setLink({ ...link, end: e.currentTarget.value })}/></Field>
            </div>
          </form>
        </DialogBody>
        <DialogFooter>
          <DialogClose>Cancel</DialogClose>
          <Button type="submit" form="import-link" pending={dj.importing} pendingLabel="Downloading" disabled={!link.url.trim()}>Import</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
      <DialogContent size="lg">
        <DialogHeader><DialogTitle>Keyboard shortcuts</DialogTitle></DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-4">
            <DialogDescription>Single keys, no modifier. They work anywhere on the page except while typing in a field.</DialogDescription>
            <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
              {SHORTCUT_GROUPS.map(group => <section key={group.title} aria-label={group.title} className="flex flex-col">
                <h3 className="border-b border-line pb-1.5 type-label-sm text-text-2">{group.title}</h3>
                <ul>
                  {group.items.map(item => <li key={item.keys} className="rule-row flex items-center justify-between gap-3 py-1.5">
                    <span className="type-body-sm text-text-2">{item.label}</span>
                    <Kbd keys={item.keys}/>
                  </li>)}
                </ul>
              </section>)}
            </div>
          </div>
        </DialogBody>
        <DialogFooter><DialogClose>Done</DialogClose></DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog role="alertdialog" confirmText="library" open={clearOpen} onOpenChange={setClearOpen}>
      <DialogContent size="sm">
        <DialogHeader><DialogTitle>Clear library</DialogTitle></DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-4">
            <DialogDescription>Deletes all {dj.tracks.length} tracks from every project, this browser and the disk backup, and empties both decks. Projects and recordings stay.</DialogDescription>
            <DialogConfirmField/>
          </div>
        </DialogBody>
        <DialogFooter>
          <DialogClose>Cancel</DialogClose>
          <DialogAction variant="destructive" onAction={projects.clearLibrary}>Clear library</DialogAction>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div></TooltipProvider>;
}
