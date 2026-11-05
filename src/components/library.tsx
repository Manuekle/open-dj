"use client";

// Room links sweep through glimm (next/link handles the click itself, so a document-level interceptor never sees it).
import { TransitionLink as Link } from "glimm/next";
import { useEffect, useRef, useState } from "react";
import { formatDate } from "@/lib/art";
import { formatTime, type DeckId, type StoredMix, type Track } from "@/lib/types";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/sodium/ui/table";
import { Frame, FrameBody, FrameDescription, FrameHeader, FrameStatus, FrameTitle, FrameValue } from "@/components/sodium/ui/frame";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/sodium/ui/item";
import { Empty, EmptyDescription, EmptyHeader, EmptyIcon, EmptyTitle } from "@/components/sodium/ui/empty-state";
import { Field, FieldLabel } from "@/components/sodium/ui/field";
import { Input } from "@/components/sodium/ui/input";
import { Status } from "@/components/sodium/ui/status";
import { Button } from "@/components/sodium/ui/button";
import { Cover } from "@/components/track-editor";
import { Hint } from "@/components/hint";
import { Digits, IconSwap, TextSwap } from "@/components/motion";
import { Add, AudioWave, CloudUpload, Download, Edit, Icon, Launch, Pause, Play, TrashCan } from "@/components/sodium/icon";

/* A preview of one library track on the browser's own output, apart from the decks and the master bus, so it never lands in a
   recording or a mix. It starts a third of the way in, where a track is usually past its intro, and stops at the end, on a
   second press, when another track is previewed, when the track is removed, or when the library goes away. */
function usePreview(tracks: Track[]) {
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const stop = () => { audio.current?.pause(); audio.current = null; setPlaying(null); };
  useEffect(() => () => { audio.current?.pause(); audio.current = null; }, []);
  useEffect(() => { if (audio.current && playing && !tracks.some(t => t.id === playing)) stop(); }, [tracks, playing]);
  const toggle = (track: Track) => {
    const same = playing === track.id;
    stop();
    if (same) return;
    const el = new Audio(track.url);
    el.preload = "auto";
    el.onended = () => { if (audio.current === el) stop(); };
    el.onerror = () => { if (audio.current === el) stop(); };
    audio.current = el;
    setPlaying(track.id);
    const start = () => { if (track.duration > 60) el.currentTime = track.duration / 3; void el.play().catch(() => { if (audio.current === el) stop(); }); };
    if (el.readyState >= 1) start(); else el.addEventListener("loadedmetadata", start, { once: true });
  };
  return { playing, toggle };
}

type LibraryProps = {
  tracks: Track[]; total: number; search: string; loaded: Record<DeckId, string | null>; selected: string | null; activeDeck: DeckId; importing: boolean;
  className?: string; onSelect: (id: string) => void; onLoad: (id: DeckId, track: Track) => void; onDelete: (id: string) => void; onEdit: (id: string) => void; onAdd: () => void; onAddLink?: () => void;
  /** Stem separation: whether Demucs runs on this machine, progress by track id, and the action that starts one. */
  stemsAvailable: boolean | null; splitting: Record<string, number>; onSplit: (id: string) => void;
  /** Lyrics for karaoke: whether Whisper runs on this machine, progress by track id, and the action that starts one. */
  lyricsAvailable?: boolean | null; transcribing?: Record<string, number>; onTranscribe?: (id: string) => void;
  /** The play queue: adds a track to its end, and how many times each track is queued now. Without onQueue the column is not shown. */
  onQueue?: (id: string) => void; onQueueAll?: () => void; queued?: Record<string, number>;
};
/* The library, with adding tracks folded into it: its footer says how and holds the picker, so no separate upload region
   stands beside it. Its scroll box takes the rest of the row, so it lines up with the recordings beside it. */
export function TrackLibrary({ tracks, total, search, loaded, selected, activeDeck, importing, className, onSelect, onLoad, onDelete, onEdit, onAdd, onAddLink, stemsAvailable, splitting, onSplit, lyricsAvailable, transcribing, onTranscribe, onQueue, onQueueAll, queued }: LibraryProps) {
  const deckOf = (id: string) => loaded.A === id ? "Deck 1" : loaded.B === id ? "Deck 2" : null;
  const preview = usePreview(tracks);
  return <Table title="Track library" count={search ? `${tracks.length} of ${total}` : total} maxHeight={440} stickyHeader
    frameClassName={className} containerClassName="flex-1"
    actions={<>
      {onQueueAll && <Hint label="Add every track shown to the end of the queue">
        <Button size="sm" variant="ghost" disabled={!tracks.length} onClick={onQueueAll}>Queue all</Button>
      </Hint>}
      {onAddLink && <Hint label="Import audio from a link, optionally cut to a range">
        <Button size="sm" variant="ghost" onClick={onAddLink}><Icon icon={Launch}/>From link</Button>
      </Hint>}
      <Hint label="Add tracks"><Button size="icon-sm" variant="ghost" onClick={onAdd} aria-label="Add tracks"><Icon icon={Add}/></Button></Hint>
    </>}
    footer={<>
      <span>Drop audio files anywhere on the page: MP3, WAV, M4A or OGG, up to 150 MB each. Double-click a row to load it on deck {activeDeck === "A" ? 1 : 2}.</span>
      <Button size="sm" variant="secondary" onClick={onAdd} pending={importing} pendingLabel="Analyzing"><Icon icon={CloudUpload}/>Browse files</Button>
    </>}>
    <TableHeader><TableRow>
      <TableHead><span className="sr-only">Preview</span></TableHead><TableHead>Title</TableHead><TableHead>Artist</TableHead><TableHead numeric>Bpm</TableHead><TableHead numeric>Length</TableHead>
      <TableHead>Stems</TableHead>{onTranscribe && <TableHead>Lyrics</TableHead>}{onQueue && <TableHead>Queue</TableHead>}<TableHead>Load</TableHead><TableHead><span className="sr-only">Edit and remove</span></TableHead>
    </TableRow></TableHeader>
    <TableBody>
      {tracks.map(t => <TableRow key={t.id} selected={selected === t.id} onClick={() => onSelect(t.id)} onDoubleClick={() => onLoad(activeDeck, t)}>
        <TableCell>
          <Hint label={preview.playing === t.id ? "Stop preview" : "Preview from the middle of the track"}>
            <Button size="icon-sm" variant="ghost" onClick={e => { e.stopPropagation(); preview.toggle(t); }} aria-pressed={preview.playing === t.id}
              aria-label={`${preview.playing === t.id ? "Stop preview of" : "Preview"} ${t.title}`}><IconSwap active={preview.playing === t.id} from={Play} to={Pause}/></Button>
          </Hint>
        </TableCell>
        <TableCell className="max-w-48">
          <div className="flex items-center gap-2"><Cover track={t} size={28}/><span className="min-w-0 truncate" title={t.title}>{t.title}</span>
            {deckOf(t.id) ? <Status size="sm" status="running">{deckOf(t.id)}</Status> : <span className="sr-only">Not loaded</span>}</div>
        </TableCell>
        <TableCell className="max-w-28"><span className="block truncate" title={t.artist}>{t.artist}</span></TableCell>
        <TableCell numeric>{t.bpm ? t.bpm.toFixed(1) : "-"}</TableCell>
        <TableCell numeric>{formatTime(t.duration)}</TableCell>
        <TableCell>
          {t.stems ? <Status size="sm" status="ok">Ready</Status>
            : splitting[t.id] !== undefined ? <Status size="sm" status="running">{`Splitting ${Math.round(splitting[t.id] * 100)}%`}</Status>
            : <Hint label={stemsAvailable === false ? "Needs Demucs on this machine: run npm run setup:stems" : "Separate vocals, drums, bass and melody"}>
              <Button size="sm" variant="ghost" disabled={!stemsAvailable} onClick={e => { e.stopPropagation(); onSplit(t.id); }}
                aria-label={`Split ${t.title} into stems`}>Split</Button>
            </Hint>}
        </TableCell>
        {onTranscribe && <TableCell>
          {transcribing?.[t.id] !== undefined ? <Status size="sm" status="running">{`Listening ${Math.round(transcribing[t.id] * 100)}%`}</Status>
            : t.lyrics ? <Link href={`/lyrics?track=${encodeURIComponent(t.id)}`} onClick={e => e.stopPropagation()}
              className="inline-flex h-(--control-sm) items-center px-2.5 type-label-sm text-text-1 hover:underline" aria-label={`Sing along to ${t.title}`}>Karaoke</Link>
            : <Hint label={lyricsAvailable === false ? "Needs whisper.cpp on this machine: run npm run setup:whisper" : t.stems ? "Write the lyrics with times, from the vocals stem" : "Write the lyrics with times for karaoke"}>
              <Button size="sm" variant="ghost" disabled={!lyricsAvailable} onClick={e => { e.stopPropagation(); onTranscribe(t.id); }}
                aria-label={`Transcribe the lyrics of ${t.title}`}>Transcribe</Button>
            </Hint>}
        </TableCell>}
        {onQueue && <TableCell>
          <Button size="sm" variant="ghost" onClick={e => { e.stopPropagation(); onQueue(t.id); }}
            aria-label={`Add ${t.title} to the queue${queued?.[t.id] ? `, queued ${queued[t.id]} ${queued[t.id] === 1 ? "time" : "times"}` : ""}`}>
            <Icon icon={Add}/>{queued?.[t.id] ? `×${queued[t.id]}` : null}
          </Button>
        </TableCell>}
        <TableCell>
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" onClick={e => { e.stopPropagation(); onLoad("A", t); }} aria-label={`Load ${t.title} on deck 1`}>1</Button>
            <Button size="sm" variant="ghost" onClick={e => { e.stopPropagation(); onLoad("B", t); }} aria-label={`Load ${t.title} on deck 2`}>2</Button>
          </div>
        </TableCell>
        <TableCell>
          <div className="flex gap-1">
            <Hint label="Edit details">
              <Button size="icon-sm" variant="ghost" onClick={e => { e.stopPropagation(); onEdit(t.id); }} aria-label={`Edit ${t.title}`}><Icon icon={Edit}/></Button>
            </Hint>
            <Hint label="Remove from library">
              <Button size="icon-sm" variant="ghost" onClick={e => { e.stopPropagation(); onDelete(t.id); }} aria-label={`Remove ${t.title}`}><Icon icon={TrashCan}/></Button>
            </Hint>
          </div>
        </TableCell>
      </TableRow>)}
      {!tracks.length && <TableEmpty colSpan={8 + (onQueue ? 1 : 0) + (onTranscribe ? 1 : 0)} title={total ? "No tracks match your search" : "Your library is empty"}
        description={total ? "Clear the search to see every track." : "Add audio files to start a session. They stay in this browser."}
        action={total ? undefined : <Button onClick={onAdd}>Add tracks</Button>}/>}
    </TableBody>
  </Table>;
}

type RecordingsProps = {
  mixes: StoredMix[]; recording: boolean; recordSeconds: number; mixName: string;
  onMixName: (name: string) => void; onRecord: () => void; onExport: (mix: StoredMix) => void; onDelete: (id: string) => void;
};
/* Recording and what it made, in one region: the name and the record action on top, the saved mixes under them. */
export function Recordings({ mixes, recording, recordSeconds, mixName, onMixName, onRecord, onExport, onDelete }: RecordingsProps) {
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<{ el: HTMLAudioElement; url: string } | null>(null);
  const stop = () => { if (!audio.current) return; audio.current.el.pause(); URL.revokeObjectURL(audio.current.url); audio.current = null; };
  useEffect(() => stop, []);
  const toggle = (mix: StoredMix) => {
    const same = playing === mix.id;
    stop(); setPlaying(null);
    if (same) return;
    const url = URL.createObjectURL(mix.blob);
    const el = new Audio(url);
    el.onended = () => { stop(); setPlaying(null); };
    audio.current = { el, url };
    void el.play().then(() => setPlaying(mix.id)).catch(() => stop());
  };

  return <Frame aria-label="Recordings" id="recordings" className="min-h-0">
    <FrameHeader>
      <FrameTitle>Recordings</FrameTitle>
      <FrameStatus><Status size="sm" status={recording ? "running" : "idle"}><TextSwap>{recording ? "Recording" : "Ready"}</TextSwap></Status></FrameStatus>
      <FrameValue meta><Digits value={formatTime(recordSeconds)}/></FrameValue>
    </FrameHeader>
    <FrameBody className="flex-none">
      <form className="flex items-end gap-2" onSubmit={e => { e.preventDefault(); onRecord(); }}>
        <Field className="min-w-0 flex-1">
          <FieldLabel optional>Mix name</FieldLabel>
          <Input value={mixName} onValueChange={onMixName} placeholder="Friday warm-up" disabled={recording} autoComplete="off"/>
        </Field>
        <Button type="submit" variant={recording ? "destructive" : "primary"}><TextSwap>{recording ? "Stop and save" : "Start recording"}</TextSwap></Button>
      </form>
      <FrameDescription>Records the master output and saves it in this browser as WebM or M4A.</FrameDescription>
    </FrameBody>
    <FrameBody padding="none" className="max-h-80 overflow-y-auto">
      {mixes.length > 0 ? <ItemGroup variant="plain" aria-label={`${mixes.length} saved ${mixes.length === 1 ? "mix" : "mixes"}`}>
        {mixes.map(m => <Item key={m.id} selected={playing === m.id}>
          <ItemMedia variant="icon"><Icon icon={AudioWave}/></ItemMedia>
          <ItemContent>
            <ItemTitle>{m.title}</ItemTitle>
            <ItemDescription>{formatTime(m.duration)} · {m.format.includes("mp4") ? "M4A" : "WebM"} · {formatDate(m.createdAt)}</ItemDescription>
          </ItemContent>
          <ItemActions>
            <Hint label={playing === m.id ? "Pause preview" : "Play preview"}>
              <Button size="icon-sm" variant="ghost" onClick={() => toggle(m)} aria-pressed={playing === m.id} aria-label={`${playing === m.id ? "Pause" : "Play"} ${m.title}`}><IconSwap active={playing === m.id} from={Play} to={Pause}/></Button>
            </Hint>
            <Hint label="Download">
              <Button size="icon-sm" variant="ghost" onClick={() => onExport(m)} aria-label={`Download ${m.title}`}><Icon icon={Download}/></Button>
            </Hint>
            <Hint label="Delete">
              <Button size="icon-sm" variant="ghost" onClick={() => { if (playing === m.id) { stop(); setPlaying(null); } onDelete(m.id); }} aria-label={`Delete ${m.title}`}><Icon icon={TrashCan}/></Button>
            </Hint>
          </ItemActions>
        </Item>)}
      </ItemGroup> : <Empty variant="plain" size="sm" reason="empty" className="flex-row items-center">
        <EmptyIcon icon={AudioWave}/>
        <EmptyHeader><EmptyTitle>No recordings yet</EmptyTitle><EmptyDescription>Start recording and your next mix shows up here.</EmptyDescription></EmptyHeader>
      </Empty>}
    </FrameBody>
  </Frame>;
}
