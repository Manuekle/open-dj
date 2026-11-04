import { cn } from "@/lib/sodium/utils";

/* The app icon's glyph (src/app/icon.svg): four ellipses fitted from its pixels and mirrored about the centre, drawn in
   currentColor without the icon's tile, so it sits on Sodium's square ground in the text colour. */
export function AppMark({ className, label }: { className?: string; label?: string }) {
  return <svg viewBox="26 24 460 460" className={cn("shrink-0", className)} fill="currentColor"
    role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
    <ellipse cx={79.1} cy={292.2} rx={104.3} ry={42.6} transform="rotate(77.9 79.1 292.2)"/>
    <ellipse cx={188} cy={253.7} rx={207.4} ry={51} transform="rotate(80.8 188 253.7)"/>
    <ellipse cx={324} cy={253.7} rx={207.4} ry={51} transform="rotate(99.2 324 253.7)"/>
    <ellipse cx={432.9} cy={292.2} rx={104.3} ry={42.6} transform="rotate(102.1 432.9 292.2)"/>
  </svg>;
}
