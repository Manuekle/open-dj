"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/sodium/utils";
import { Icon, type SodiumIcon } from "@/components/sodium/icon";

/* React bindings for the transitions.dev recipes in app/transitions.css. Each one only toggles the recipe's documented
   classes and attributes; the timing lives in the CSS variables, read back here where JS has to wait on it. */

/** A duration variable in milliseconds. The built CSS may write 140ms as ".14s", so the unit is read, not assumed. */
const ms = (el: Element, name: string, fallback: number) => {
  const value = getComputedStyle(el).getPropertyValue(name).trim();
  const n = parseFloat(value);
  return Number.isFinite(n) ? (value.endsWith("ms") ? n : value.endsWith("s") ? n * 1000 : n) : fallback;
};

/** Icon swap: two glyphs in one slot, cross-faded with blur and scale. `active` shows `to`. */
export function IconSwap({ active, from, to, size }: { active: boolean; from: SodiumIcon; to: SodiumIcon; size?: 14 | 16 | 20 }) {
  return <span className="t-icon-swap" data-state={active ? "b" : "a"} aria-hidden>
    <span className="t-icon" data-icon="a"><Icon icon={from} size={size}/></span>
    <span className="t-icon" data-icon="b"><Icon icon={to} size={size}/></span>
  </span>;
}

/** Text states swap: the old text leaves upward with a blur, then the new one rises in. For words, not running clocks. */
export function TextSwap({ children, className }: { children: string; className?: string }) {
  const el = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(children);
  useEffect(() => {
    const node = el.current;
    if (!node || children === shown) return;
    node.classList.add("is-exit");
    const timer = window.setTimeout(() => setShown(children), ms(node, "--text-swap-dur", 150));
    return () => window.clearTimeout(timer);
  }, [children, shown]);
  // The new text is in: jump it below without a transition, reflow, then let it rise to rest.
  useLayoutEffect(() => {
    const node = el.current;
    if (!node?.classList.contains("is-exit")) return;
    node.classList.remove("is-exit");
    node.classList.add("is-enter-start");
    void node.offsetHeight;
    node.classList.remove("is-enter-start");
  }, [shown]);
  return <span ref={el} className={cn("t-text-swap", className)}>{shown}</span>;
}

/** Number pop-in: only the characters that changed pop in, the shared leading ones stay still. */
export function Digits({ value, className }: { value: string; className?: string }) {
  const group = useRef<HTMLSpanElement>(null);
  const [current, setCurrent] = useState({ value, same: value.length });
  if (current.value !== value) {
    let same = 0;
    while (same < current.value.length && same < value.length && current.value[same] === value[same]) same++;
    setCurrent({ value, same });
  }
  useLayoutEffect(() => {
    const el = group.current;
    if (!el || current.same >= current.value.length) return;
    el.classList.remove("is-animating");
    void el.offsetHeight;
    el.classList.add("is-animating");
  }, [current]);
  return <span className={className}>
    <span className="sr-only">{current.value}</span>
    <span ref={group} className="t-digit-group" aria-hidden>
      {current.value.split("").map((ch, i) => {
        const changed = i - current.same;
        return <span key={i} className="t-digit" data-same={changed < 0 ? "" : undefined}
          data-stagger={changed === 1 || changed === 2 ? String(changed) : undefined}>{ch}</span>;
      })}
    </span>
  </span>;
}

/** Card resize: tweens a region's height whenever its content grows or shrinks. */
export function AutoHeight({ children, className }: { children: React.ReactNode; className?: string }) {
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    const el = inner.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setHeight(el.offsetHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return <div className={cn("t-resize overflow-hidden", height !== null && "h-(--h)")}
    style={height === null ? undefined : { "--h": `${height}px` } as React.CSSProperties}>
    <div ref={inner} className={className}>{children}</div>
  </div>;
}

/** Page side-by-side: when `id` changes, the old content (as it last was) leaves to one side while the new one arrives from
    the other, both at once. `order` says which way: a higher one than before is forward (arrives from the right). While
    `id` stays the same the content simply follows its children, so a live editor keeps updating. The first mount and
    reduced motion do not animate. */
export function PageSwap({ id, order, children, className }: { id: string; order: number; children: React.ReactNode; className?: string }) {
  type Shown = { id: string; order: number; node: React.ReactNode; dir: 1 | -1; entering: boolean; leaving: { node: React.ReactNode; nonce: number } | null; nonce: number };
  const [shown, setShown] = useState<Shown>({ id, order, node: children, dir: 1, entering: false, leaving: null, nonce: 0 });
  if (shown.id !== id) {
    setShown({ id, order, node: children, dir: order >= shown.order ? 1 : -1, entering: true, leaving: { node: shown.node, nonce: shown.nonce + 1 }, nonce: shown.nonce + 1 });
  } else if (shown.node !== children) {
    setShown({ ...shown, node: children });
  }
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!shown.leaving) return;
    const timer = window.setTimeout(() => setShown(prev => prev.nonce === shown.nonce ? { ...prev, entering: false, leaving: null } : prev),
      el.current ? ms(el.current, "--page-slide-dur", 250) + 30 : 280);
    return () => window.clearTimeout(timer);
  }, [shown.leaving, shown.nonce]);
  return <div ref={el} className={cn("t-page-swap", className)} style={{ "--t-dir": shown.dir } as React.CSSProperties}>
    {/* Keyed by the nonce, so each step mounts a fresh element and plays its animation from the start. */}
    <div key={`in-${shown.nonce}`} className={shown.entering ? "t-page-entering" : undefined}>{shown.node}</div>
    {shown.leaving && <div key={`out-${shown.leaving.nonce}`} aria-hidden inert className="t-page-leaving">{shown.leaving.node}</div>}
  </div>;
}

/** The modal recipe's three states for a surface that opens and closes: "is-open", then "is-closing" until the close
    transition ends, then none. */
export function usePresence(open: boolean) {
  const [state, setState] = useState<"" | "is-open" | "is-closing">(open ? "is-open" : "");
  if (open && state !== "is-open") setState("is-open");
  if (!open && state === "is-open") setState("is-closing");
  useEffect(() => {
    if (state !== "is-closing") return;
    const timer = window.setTimeout(() => setState(""), ms(document.documentElement, "--modal-close-dur", 150));
    return () => window.clearTimeout(timer);
  }, [state]);
  return state;
}
