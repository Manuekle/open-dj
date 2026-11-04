"use client";

import { memo, useRef } from "react";
import { formatTime } from "@/lib/types";
import { useScrollTabStop } from "@/lib/sodium/scroll";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMeta, ItemTitle } from "@/components/sodium/ui/item";
import { Button } from "@/components/sodium/ui/button";
import { Tag } from "@/components/sodium/ui/tag";
import { Status } from "@/components/sodium/ui/status";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/sodium/ui/empty-state";
import { Hint } from "@/components/hint";
import { Add, ArrowDown, ArrowUp, Close, Icon, Next, Play, Renew, TrashCan } from "@/components/sodium/icon";
import type { QueueActions, QueueRow } from "./model";

type Props = {
  rows: QueueRow[];
  smart: boolean;
  /** Library tracks not in the queue yet, which "Queue library" adds. */
  unqueued: string[];
  /** Whether the engine is moving between tracks, so the next entry cannot change under it. */
  locked: boolean;
  actions: QueueActions;
};

/* The smart queue: the entry playing, what follows in play order, and failed entries to retry. Every button calls the
   engine's queue edit and the list re-renders from the engine's queue, so what shows is what will play. Moving an entry
   switches smart order off in the engine, and the ordering control above shows it. */
export const QueueList = memo(function QueueList({ rows, smart, unqueued, locked, actions }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const tabStop = useScrollTabStop(scroller);
  const movable = rows.filter(r => r.state === "next" || r.state === "upcoming");
  const failed = rows.some(r => r.state === "failed");

  return <section aria-label="Smart queue" className="flex min-w-0 flex-col">
    <div className="flex h-(--control) items-center gap-2 border-b border-line-faint">
      <h3 className="type-label-sm text-text-2">Queue</h3>
      <span className="type-code-sm text-text-3">{movable.length} up next</span>
      {smart && <Tag size="sm" variant="outline">Smart order</Tag>}
      <div className="ms-auto flex items-center gap-1">
        {failed && <Hint label="Try failed tracks again">
          <Button size="icon-sm" variant="ghost" onClick={actions.retryFailed} aria-label="Try failed tracks again"><Icon icon={Renew}/></Button>
        </Hint>}
        <Hint label={unqueued.length ? `Add ${unqueued.length} library ${unqueued.length === 1 ? "track" : "tracks"} to the queue` : "Every library track is queued"}>
          <Button size="icon-sm" variant="ghost" disabled={!unqueued.length} onClick={() => actions.add(unqueued, "end")} aria-label="Queue the library"><Icon icon={Add}/></Button>
        </Hint>
        <Hint label="Clear the queue, keeping the track that plays">
          <Button size="icon-sm" variant="ghost" disabled={!movable.length && !failed} onClick={actions.clear} aria-label="Clear the queue"><Icon icon={TrashCan}/></Button>
        </Hint>
      </div>
    </div>
    {rows.length ? <div ref={scroller} tabIndex={tabStop} aria-label="Queue entries" className="max-h-72 overflow-y-auto">
      <ItemGroup variant="plain">
        {rows.map(row => {
          const { item, track, state } = row;
          const at = movable.indexOf(row);
          const title = track?.title ?? "Missing track";
          const facts = track ? [track.artist, track.bpm ? `${track.bpm.toFixed(1)} bpm` : null, track.camelot ?? null].filter(Boolean).join(" · ") : "Removed from the library";
          return <Item key={item.uid} size="sm" selected={state === "current"} aria-current={state === "current" ? "true" : undefined}>
            <ItemContent>
              <ItemTitle><span>{title}</span>
                {state === "current" && <Tag size="sm" variant="neutral">Now</Tag>}
                {state === "next" && <Tag size="sm" variant="outline">Next</Tag>}
                {state === "failed" && <Status size="sm" status="fail">Failed</Status>}
              </ItemTitle>
              <ItemDescription>{state === "failed" && item.reason ? item.reason : facts}</ItemDescription>
            </ItemContent>
            {track && <ItemMeta>{formatTime(track.duration)}</ItemMeta>}
            {(state === "next" || state === "upcoming") && <ItemActions>
              <Hint label={smart ? "Move up, switching to original order" : "Move up"}>
                <Button size="icon-sm" variant="ghost" disabled={at <= 0 || (locked && state === "next")} onClick={() => actions.move(item.uid, -1)} aria-label={`Move ${title} up`}><Icon icon={ArrowUp}/></Button>
              </Hint>
              <Hint label={smart ? "Move down, switching to original order" : "Move down"}>
                <Button size="icon-sm" variant="ghost" disabled={at < 0 || at >= movable.length - 1 || (locked && state === "next")} onClick={() => actions.move(item.uid, 1)} aria-label={`Move ${title} down`}><Icon icon={ArrowDown}/></Button>
              </Hint>
              {state === "upcoming" && actions.jumpTo && <Hint label="Mix into this track now">
                <Button size="icon-sm" variant="ghost" disabled={locked} onClick={() => actions.jumpTo?.(item.uid)} aria-label={`Mix into ${title} now`}><Icon icon={Play}/></Button>
              </Hint>}
              {state === "upcoming" && <Hint label="Play next">
                <Button size="icon-sm" variant="ghost" disabled={locked} onClick={() => actions.playNext(item.uid)} aria-label={`Play ${title} next`}><Icon icon={Next}/></Button>
              </Hint>}
              <Hint label="Remove from the queue">
                <Button size="icon-sm" variant="ghost" disabled={locked && state === "next"} onClick={() => actions.remove(item.uid)} aria-label={`Remove ${title} from the queue`}><Icon icon={Close}/></Button>
              </Hint>
            </ItemActions>}
            {state === "failed" && <ItemActions>
              <Hint label="Remove from the queue">
                <Button size="icon-sm" variant="ghost" onClick={() => actions.remove(item.uid)} aria-label={`Remove ${title} from the queue`}><Icon icon={Close}/></Button>
              </Hint>
            </ItemActions>}
          </Item>;
        })}
      </ItemGroup>
    </div> : <Empty variant="plain" size="sm" reason="empty">
      <EmptyHeader>
        <EmptyTitle>Queue is empty</EmptyTitle>
        <EmptyDescription>Add the library or single tracks from the library table. AutoMix plays them in order.</EmptyDescription>
      </EmptyHeader>
    </Empty>}
  </section>;
});
