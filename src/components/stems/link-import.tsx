"use client";

import { useState } from "react";
import { downloadFromLink } from "@/lib/background-jobs";
import { Button } from "@/components/sodium/ui/button";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/sodium/ui/dialog";
import { Field, FieldLabel } from "@/components/sodium/ui/field";
import { Input } from "@/components/sodium/ui/input";
import { Switch } from "@/components/sodium/ui/switch";

/* The decks page's link import, on the Stems page: the server downloads the audio (yt-dlp, ffmpeg), the page adds it to
   the library, and with "Split when it arrives" on, Demucs separates it straight away so it opens here with its stems. */
export function LinkImport({ open, onOpenChange, split, onSplitChange }: {
  open: boolean; onOpenChange: (open: boolean) => void; split: boolean; onSplitChange: (split: boolean) => void;
}) {
  const [link, setLink] = useState({ url: "", start: "", end: "" });
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    // The download runs in lib/background-jobs; the dialog closes once the server has answered with the file.
    const ok = await downloadFromLink(link.url.trim(), link.start.trim(), link.end.trim());
    setBusy(false);
    if (ok) { onOpenChange(false); setLink({ url: "", start: "", end: "" }); }
  };
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent size="sm">
      <DialogHeader><DialogTitle>Import from a link</DialogTitle></DialogHeader>
      <DialogBody>
        <form id="stems-import-link" className="flex flex-col gap-4" onSubmit={e => { e.preventDefault(); void submit(); }}>
          <DialogDescription>The machine running this app downloads the audio with yt-dlp and ffmpeg. Use only audio you have the right to copy: public domain, Creative Commons or your own.</DialogDescription>
          <Field><FieldLabel>Link</FieldLabel>
            <Input type="url" required autoFocus placeholder="https://www.youtube.com/watch?v=…" value={link.url} onChange={e => setLink({ ...link, url: e.currentTarget.value })}/></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field><FieldLabel>Start (optional)</FieldLabel><Input placeholder="0:30" value={link.start} onChange={e => setLink({ ...link, start: e.currentTarget.value })}/></Field>
            <Field><FieldLabel>End (optional)</FieldLabel><Input placeholder="3:45" value={link.end} onChange={e => setLink({ ...link, end: e.currentTarget.value })}/></Field>
          </div>
          <label className="flex items-center gap-2 type-label-sm text-text-2"><Switch checked={split} onCheckedChange={onSplitChange}/>Split into stems when it arrives</label>
        </form>
      </DialogBody>
      <DialogFooter>
        <DialogClose>Cancel</DialogClose>
        <Button type="submit" form="stems-import-link" pending={busy} pendingLabel="Downloading" disabled={!link.url.trim()}>Import</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
