"use client";

import { useEffect, useRef, useState } from "react";
import type { Track } from "@/lib/types";
import { Button } from "@/components/sodium/ui/button";
import { Field, FieldLabel } from "@/components/sodium/ui/field";
import { Input } from "@/components/sodium/ui/input";
import { Dialog, DialogAction, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/sodium/ui/dialog";
import { Icon, Renew, TrashCan, Upload } from "@/components/sodium/icon";
import { MAX_BPM, MIN_BPM, parseBpm, tapBpm } from "@/lib/manual-tempo";

export type TrackPatch = { title: string; artist: string; album: string; year: string; genre: string; cover?: Blob | null;
  /** A bpm and first beat set by hand, or "detect" to go back to the analysis. Absent when the tempo was not touched. */
  tempo?: { bpm: number; firstBeat: number } | "detect" };

export function Cover({ track, size = 40, className }: { track?: Pick<Track, "coverUrl" | "title">; size?: number; className?: string }) {
  const style = { width: size, height: size };
  return track?.coverUrl
    // eslint-disable-next-line @next/next/no-img-element
    ? <img src={track.coverUrl} alt="" style={style} className={`shrink-0 object-cover ${className ?? ""}`}/>
    : <div aria-hidden style={style} className={`bg-well text-text-2 type-caption grid shrink-0 place-items-center ${className ?? ""}`}>♪</div>;
}

type Props = { track: Track | null; onClose: () => void; onSave: (id: string, patch: TrackPatch) => Promise<void> };
export function TrackEditor({ track, onClose, onSave }: Props) {
  return <Dialog open={!!track} onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent size="lg">{track && <Form key={track.id} track={track} onClose={onClose} onSave={onSave}/>}</DialogContent>
  </Dialog>;
}

function Form({ track, onClose, onSave }: { track: Track; onClose: () => void; onSave: Props["onSave"] }) {
  const [title, setTitle] = useState(track.title);
  const [artist, setArtist] = useState(track.artist);
  const [album, setAlbum] = useState(track.album ?? "");
  const [year, setYear] = useState(track.year ?? "");
  const [genre, setGenre] = useState(track.genre ?? "");
  // undefined keeps the stored cover, null removes it, a Blob replaces it.
  const [cover, setCover] = useState<Blob | null | undefined>(undefined);
  const [preview, setPreview] = useState<string | undefined>(track.coverUrl);
  // Tempo: the bpm and first beat as typed, kept as text so a half-typed number is not rewritten under the cursor.
  const [bpm, setBpm] = useState(track.bpm ? String(track.bpm) : "");
  const [firstBeat, setFirstBeat] = useState(track.firstBeat ? String(track.firstBeat) : "");
  const [detect, setDetect] = useState(false);
  const taps = useRef<number[]>([]);
  const parsed = parseBpm(bpm);
  const bpmInvalid = bpm.trim() !== "" && parsed === null;
  const firstValue = firstBeat.trim() === "" ? 0 : Number(firstBeat.replace(",", "."));
  const firstInvalid = !Number.isFinite(firstValue) || firstValue < 0;
  const tempoChanged = !detect && parsed !== null && (parsed !== track.bpm || firstValue !== (track.firstBeat ?? 0));
  const tap = () => {
    taps.current = [...taps.current.slice(-15), performance.now() / 1000];
    const next = tapBpm(taps.current);
    if (next !== null) { setBpm(String(next)); setDetect(false); }
  };
  const scale = (by: number) => { if (parsed === null) return; const next = parseBpm(String(parsed * by)); if (next !== null) { setBpm(String(next)); setDetect(false); } };
  const picker = useRef<HTMLInputElement>(null);
  const objectUrl = useRef<string | null>(null);
  useEffect(() => () => { if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); }, []);

  function choose(file: File | undefined) {
    if (!file || !file.type.startsWith("image/")) return;
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = URL.createObjectURL(file);
    setCover(file); setPreview(objectUrl.current);
  }
  function remove() {
    if (objectUrl.current) { URL.revokeObjectURL(objectUrl.current); objectUrl.current = null; }
    setCover(null); setPreview(undefined);
  }

  return <>
    <DialogHeader><DialogTitle>Track info</DialogTitle></DialogHeader>
    <DialogBody>
      <div className="flex flex-col gap-5">
        <DialogDescription>{track.fileName}</DialogDescription>
        {/* The cover beside the three fields that name the track, then what classifies it, then its tempo. */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[auto_1fr]">
          <div className="flex flex-col items-start gap-2">
            <Cover track={{ coverUrl: preview, title: title }} size={128}/>
            <Button size="sm" variant="secondary" onClick={() => picker.current?.click()}><Icon icon={Upload}/>{preview ? "Replace cover" : "Upload cover"}</Button>
            {preview && <Button size="sm" variant="ghost" onClick={remove}><Icon icon={TrashCan}/>Remove cover</Button>}
            <div className="sr-only" aria-hidden><Input ref={picker} type="file" accept="image/*" tabIndex={-1} aria-label="Cover image" onChange={e => { choose(e.currentTarget.files?.[0]); e.currentTarget.value = ""; }}/></div>
          </div>
          <div className="flex min-w-0 flex-col gap-4">
            <Field><FieldLabel>Title</FieldLabel><Input value={title} onValueChange={setTitle} autoComplete="off"/></Field>
            <Field><FieldLabel>Artist</FieldLabel><Input value={artist} onValueChange={setArtist} autoComplete="off"/></Field>
            <Field><FieldLabel optional>Album</FieldLabel><Input value={album} onValueChange={setAlbum} autoComplete="off"/></Field>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field><FieldLabel optional>Year</FieldLabel><Input value={year} onValueChange={setYear} inputMode="numeric" maxLength={4} autoComplete="off"/></Field>
          <Field><FieldLabel optional>Genre</FieldLabel><Input value={genre} onValueChange={setGenre} autoComplete="off"/></Field>
        </div>
        <fieldset className="flex flex-col gap-3 border-0 border-t border-line-faint p-0 pt-4">
          <legend className="type-label-sm text-text-2 float-left w-full pb-3">Tempo{track.tempoManual && !detect ? " · set by hand" : ""}</legend>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <Field><FieldLabel>Bpm</FieldLabel>
              <Input value={detect ? "" : bpm} onValueChange={v => { setBpm(v); setDetect(false); }} inputMode="decimal" autoComplete="off" aria-invalid={bpmInvalid || undefined}
                placeholder={detect ? "Detected on save" : `${MIN_BPM} to ${MAX_BPM}`}/></Field>
            <Field><FieldLabel optional>First beat (s)</FieldLabel>
              <Input value={firstBeat} onValueChange={v => { setFirstBeat(v); setDetect(false); }} inputMode="decimal" autoComplete="off" aria-invalid={firstInvalid || undefined} placeholder="0"/></Field>
            <div className="flex items-center gap-1">
              <Button size="sm" variant="secondary" onClick={tap}>Tap tempo</Button>
              <Button size="sm" variant="ghost" disabled={parsed === null} onClick={() => scale(0.5)} aria-label="Halve the tempo">÷2</Button>
              <Button size="sm" variant="ghost" disabled={parsed === null} onClick={() => scale(2)} aria-label="Double the tempo">×2</Button>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="type-body-sm text-text-3">Tap along to the beat, or type the tempo. The first beat places the grid on the music.</span>
            <Button size="sm" variant="ghost" onClick={() => setDetect(true)} aria-pressed={detect}><Icon icon={Renew}/>Detect again</Button>
          </div>
        </fieldset>
      </div>
    </DialogBody>
    <DialogFooter>
      <DialogClose>Cancel</DialogClose>
      <DialogAction disabled={bpmInvalid || firstInvalid}
        onAction={async () => { await onSave(track.id, { title, artist, album, year, genre, cover, tempo: detect ? "detect" : tempoChanged && parsed !== null ? { bpm: parsed, firstBeat: firstValue } : undefined }); onClose(); }}>Save</DialogAction>
    </DialogFooter>
  </>;
}
