"use client";

import { useEffect, useRef, useState } from "react";
import type { Track } from "@/lib/types";
import { Button } from "@/components/sodium/ui/button";
import { Field, FieldLabel } from "@/components/sodium/ui/field";
import { Input } from "@/components/sodium/ui/input";
import { Dialog, DialogAction, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/sodium/ui/dialog";
import { Icon, TrashCan, Upload } from "@/components/sodium/icon";

export type TrackPatch = { title: string; artist: string; album: string; year: string; genre: string; cover?: Blob | null };

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
    <DialogContent size="sm">{track && <Form key={track.id} track={track} onClose={onClose} onSave={onSave}/>}</DialogContent>
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
      <div className="flex flex-col gap-4">
        <DialogDescription>{track.fileName}</DialogDescription>
        <div className="flex items-center gap-3">
          <Cover track={{ coverUrl: preview, title: title }} size={96}/>
          <div className="flex flex-col items-start gap-2">
            <Button size="sm" variant="secondary" onClick={() => picker.current?.click()}><Icon icon={Upload}/>{preview ? "Replace cover" : "Upload cover"}</Button>
            {preview && <Button size="sm" variant="ghost" onClick={remove}><Icon icon={TrashCan}/>Remove cover</Button>}
            <div className="sr-only" aria-hidden><Input ref={picker} type="file" accept="image/*" tabIndex={-1} aria-label="Cover image" onChange={e => { choose(e.currentTarget.files?.[0]); e.currentTarget.value = ""; }}/></div>
          </div>
        </div>
        <Field><FieldLabel>Title</FieldLabel><Input value={title} onValueChange={setTitle} autoComplete="off"/></Field>
        <Field><FieldLabel>Artist</FieldLabel><Input value={artist} onValueChange={setArtist} autoComplete="off"/></Field>
        <Field><FieldLabel optional>Album</FieldLabel><Input value={album} onValueChange={setAlbum} autoComplete="off"/></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field><FieldLabel optional>Year</FieldLabel><Input value={year} onValueChange={setYear} inputMode="numeric" maxLength={4} autoComplete="off"/></Field>
          <Field><FieldLabel optional>Genre</FieldLabel><Input value={genre} onValueChange={setGenre} autoComplete="off"/></Field>
        </div>
      </div>
    </DialogBody>
    <DialogFooter>
      <DialogClose>Cancel</DialogClose>
      <DialogAction onAction={async () => { await onSave(track.id, { title, artist, album, year, genre, cover }); onClose(); }}>Save</DialogAction>
    </DialogFooter>
  </>;
}
