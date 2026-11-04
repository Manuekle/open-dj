"use client";

import { useState } from "react";
import type { Projects } from "@/hooks/use-projects";
import { Hint } from "@/components/hint";
import { TextSwap } from "@/components/motion";
import { Button } from "@/components/sodium/ui/button";
import { Pick } from "@/components/pick";
import { Status } from "@/components/sodium/ui/status";
import { Input } from "@/components/sodium/ui/input";
import { Field, FieldLabel } from "@/components/sodium/ui/field";
import { Dialog, DialogAction, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/sodium/ui/dialog";
import { Add, Edit, Icon, TrashCan } from "@/components/sodium/icon";

const clock = (at: number) => new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });

/* The header cell for projects: which set is open, its save state, and new, rename and delete. */
export function ProjectBar({ projects }: { projects: Projects }) {
  const [naming, setNaming] = useState<"new" | "rename" | null>(null);
  const [name, setName] = useState("");
  const [deleting, setDeleting] = useState(false);
  const current = projects.current;
  const saved = projects.saveState === "failed" ? "Not saved" : projects.saveState === "saving" ? "Saving" : projects.savedAt ? `Saved ${clock(projects.savedAt)}` : "Not saved yet";
  const where = projects.backup ? (projects.backedUpAt ? `Backed up to disk at ${clock(projects.backedUpAt)}` : "Backup to disk on") : "This browser only";

  return <>
    <div className="flex h-12 min-w-0 items-center gap-2 border-e border-line px-3">
      <Pick aria-label="Project" className="w-44" value={current?.id ?? null} disabled={!current}
        items={projects.projects.map(p => ({ value: p.id, label: p.name }))} onValueChange={v => { if (v !== current?.id) projects.open(v); }}/>
      <Hint label="New project">
        <Button size="icon-sm" variant="ghost" disabled={!current} onClick={() => { setName(""); setNaming("new"); }} aria-label="New project"><Icon icon={Add}/></Button>
      </Hint>
      <Hint label="Rename project">
        <Button size="icon-sm" variant="ghost" disabled={!current} onClick={() => { setName(current?.name ?? ""); setNaming("rename"); }} aria-label="Rename project"><Icon icon={Edit}/></Button>
      </Hint>
      <Hint label="Delete project">
        <Button size="icon-sm" variant="ghost" disabled={!current || projects.projects.length < 2} onClick={() => setDeleting(true)} aria-label="Delete project"><Icon icon={TrashCan}/></Button>
      </Hint>
      <Hint label={where}>
        <span className="hidden lg:inline-flex" tabIndex={0}>
          <Status size="sm" status={projects.saveState === "failed" ? "fail" : projects.saveState === "saving" ? "running" : projects.savedAt ? "ok" : "idle"}>
            <TextSwap>{saved}</TextSwap>
          </Status>
        </span>
      </Hint>
    </div>

    <Dialog open={naming !== null} onOpenChange={open => { if (!open) setNaming(null); }}>
      <DialogContent size="sm">
        <DialogHeader><DialogTitle>{naming === "new" ? "New project" : "Rename project"}</DialogTitle></DialogHeader>
        <DialogBody>
          <form id="project-name" className="flex flex-col gap-4" onSubmit={e => {
            e.preventDefault();
            if (naming === "new") void projects.create(name); else if (current) void projects.rename(current.id, name);
            setNaming(null);
          }}>
            {naming === "new" && <DialogDescription>Starts with an empty library and both decks empty. The open project is saved first.</DialogDescription>}
            <Field>
              <FieldLabel>Name</FieldLabel>
              <Input value={name} onValueChange={setName} placeholder="Saturday warm-up" autoComplete="off" autoFocus/>
            </Field>
          </form>
        </DialogBody>
        <DialogFooter>
          <DialogClose>Cancel</DialogClose>
          <Button type="submit" form="project-name">{naming === "new" ? "Create project" : "Rename project"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog role="alertdialog" open={deleting} onOpenChange={setDeleting}>
      <DialogContent size="sm">
        <DialogHeader><DialogTitle>Delete project</DialogTitle></DialogHeader>
        <DialogBody>
          <DialogDescription>Deletes {current?.name} and its session. Tracks no other project uses are deleted from this browser and the disk backup.</DialogDescription>
        </DialogBody>
        <DialogFooter>
          <DialogClose>Cancel</DialogClose>
          <DialogAction variant="destructive" onAction={() => current ? projects.remove(current.id) : undefined}>Delete project</DialogAction>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
