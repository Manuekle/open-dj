import {HugeiconsIcon, type HugeiconsIconProps, type IconSvgElement} from '@hugeicons/react';
import {
  Activity01Icon, ArrowExpand01Icon, ArrowHorizontalIcon, ArrowShrink01Icon, Calendar03Icon, CancelCircleIcon, ChipIcon,
  ComputerTerminal01Icon, CubeIcon, DashboardSpeed01Icon, Database01Icon, FilterHorizontalIcon, FilterIcon,
  Flowchart01Icon, Folder01Icon, FolderOpenIcon, GitBranchIcon, Grid3x3Icon, HeadphonesIcon, LibraryIcon, LinkSquare02Icon,
  Loading03Icon, Menu01Icon, Moon02Icon, MoreHorizontalIcon, MusicNote01Icon, Orbit01Icon, SlidersHorizontalIcon,
  Sun03Icon, TextWrapIcon, Undo02Icon, UnfoldLessIcon, Vynil01Icon, FlashIcon, ServerStack01Icon, File01Icon, VolumeHighIcon,
} from '@hugeicons/core-free-icons';
import {cn} from '@/lib/sodium/utils';

// The one place Sodium imports icons from. Components import from here, never from the icon package, so the set
// can be swapped in one file.
//
// This project swaps Sodium's Lucide set for Hugeicons (free stroke set), squared off: every glyph renders with square
// ends, mitred joins and a 1.25px line at every size, just heavier than a rule, so a glyph reads as a mark and not as
// another edge. Hugeicons draws soft corners into its paths, so the glyphs the app shows are redrawn below on the 24
// grid with hard corners. Transport glyphs (play, pause, skip, record, stop) are solid; a glyph that marks a point
// (the dot of an alert, a pupil) fills just that part; the rest are line. One weight, so there is nothing to pick:
// pass a size. 16 in every control, 14 inside a small field, 20 on its own, 24 and 32 for an empty state. The export
// names are Sodium's own; to use another glyph, draw or import it here and name it.

export type SodiumIcon = IconSvgElement;

type Part = readonly [string, {readonly [key: string]: string | number}];
const line = (d: string): Part => ['path', {d}];
const solid = (d: string): Part => ['path', {d, fill: 'currentColor'}];
const ring = (cx: number, cy: number, r: number, fill = false): Part => ['circle', {cx, cy, r, ...(fill && {fill: 'currentColor'})}];
const glyph = (...parts: Part[]): SodiumIcon => parts.map(([tag, attrs], i) => [tag, {...attrs, key: String(i)}] as const);

const gear = 'M9.95 5.31L10.51 2.62H13.49L14.05 5.31L15.29 5.82L17.58 4.31L19.69 6.42L18.18 8.71L18.69 9.95L21.38 10.51V13.49L18.69 14.05L18.18 15.29L19.69 17.58L17.58 19.69L15.29 18.18L14.05 18.69L13.49 21.38H10.51L9.95 18.69L8.71 18.18L6.42 19.69L4.31 17.58L5.82 15.29L5.31 14.05L2.62 13.49V10.51L5.31 9.95L5.82 8.71L4.31 6.42L6.42 4.31L8.71 5.82Z';
const eye = 'M2 12Q12 1.5 22 12Q12 22.5 2 12Z';
const tray = 'M4 15V20H20V15';

// Transport, solid.
export const Play = glyph(solid('M7.5 5V19L19 12Z'));
export const Pause = glyph(solid('M6 5H10V19H6Z'), solid('M14 5H18V19H14Z'));
export const Next = glyph(solid('M5 5V19L15.5 12Z'), solid('M18 5H19V19H18Z'));
export const Previous = glyph(solid('M19 5V19L8.5 12Z'), solid('M5 5H6V19H5Z'));
export const Record = glyph(ring(12, 12, 6.5, true));
export const Stop = glyph(solid('M6 6H18V18H6Z'));
export const StopOutline = glyph(line('M4 4H20V20H4Z'), solid('M9 9H15V15H9Z'));

// Line, redrawn with hard corners.
export const Add = glyph(line('M12 5V19M5 12H19'));
export const Subtract = glyph(line('M5 12H19'));
export const Close = glyph(line('M6 6L18 18M18 6L6 18'));
export const Checkmark = glyph(line('M5 12.5L9.5 17L19 7'));
export const ChevronDown = glyph(line('M6 9L12 15L18 9'));
export const ChevronUp = glyph(line('M6 15L12 9L18 15'));
export const ChevronLeft = glyph(line('M15 6L9 12L15 18'));
export const ChevronRight = glyph(line('M9 6L15 12L9 18'));
export const ChevronSort = glyph(line('M7 9.5L12 4.5L17 9.5M7 14.5L12 19.5L17 14.5'));
export const ArrowDown = glyph(line('M12 4V18'), line('M6 13L12 19L18 13'));
export const ArrowUp = glyph(line('M12 20V6'), line('M6 11L12 5L18 11'));
export const ArrowLeft = glyph(line('M20 12H6'), line('M11 6L5 12L11 18'));
export const ArrowRight = glyph(line('M4 12H18'), line('M13 6L19 12L13 18'));
export const ArrowUpRight = glyph(line('M6 18L17 7'), line('M8 6H18V16'));
export const Download = glyph(line(tray), line('M12 4V14'), line('M7 10L12 15L17 10'));
export const Upload = glyph(line(tray), line('M12 16V5'), line('M7 9L12 4L17 9'));
export const CloudUpload = glyph(line('M8 18H5L3 16V13L5 11H6V9L9 6H14L17 9V10H19L21 12V16L19 18H16'), line('M12 20V12'), line('M9 14L12 11L15 14'));
export const Copy = glyph(line('M8 8H20V20H8Z'), line('M16 8V4H4V16H8'));
export const DataTable = glyph(line('M3 4H21V20H3Z'), line('M3 9H21M3 14.5H21M9 9V20'));
export const Edit = glyph(line('M4 20V16L15 5L19 9L8 20Z'), line('M12.5 7.5L16.5 11.5'), line('M13 20H20'));
export const TrashCan = glyph(line('M3.5 6H20.5'), line('M9 6V3H15V6'), line('M6 6L7 21H17L18 6'), line('M10 10V17M14 10V17'));
export const ErrorOutline = glyph(line('M4 4H20V20H4Z'), line('M12 7.5V13'), solid('M11.5 15.75H12.5V16.75H11.5Z'));
export const Information = glyph(line('M4 4H20V20H4Z'), line('M12 11V16.5'), solid('M11.5 7.25H12.5V8.25H11.5Z'));
export const WarningAlt = glyph(line('M12 3.5L21.5 20H2.5Z'), line('M12 9.5V14'), solid('M11.5 16.25H12.5V17.25H11.5Z'));
export const Keyboard = glyph(line('M2.5 6H21.5V18H2.5Z'), line('M6 10H7M9.5 10H10.5M13.5 10H14.5M17 10H18'), line('M7 14H17'));
export const Locked = glyph(line('M5 10H19V21H5Z'), line('M8 10V3H16V10'), line('M12 14V17'));
export const Renew = glyph(line('M20 12A8 8 0 1 1 18 6.7'), line('M19 2.5V7H14.5'));
export const Repeat = glyph(line('M4 12V7H19'), line('M16 4L19 7L16 10'), line('M20 12V17H5'), line('M8 14L5 17L8 20'));
export const Search = glyph(ring(10.5, 10.5, 6.5), line('M15.5 15.5L20.5 20.5'));
export const Settings = glyph(line(gear), ring(12, 12, 3));
export const View = glyph(line(eye), ring(12, 12, 2.5, true));
export const ViewOff = glyph(line(eye), ring(12, 12, 2.5, true), line('M4 4L20 20'));
export const Sparkles = glyph(line('M11 3L12.5 9.5L19 11L12.5 12.5L11 19L9.5 12.5L3 11L9.5 9.5Z'), line('M18.5 15V21M15.5 18H21.5'));
export const Time = glyph(ring(12, 12, 9), line('M12 6.5V12H16.5'));
export const AudioWave = glyph(line('M3 11V13M6 8V16M9 4V20M12 7V17M15 9V15M18 6V18M21 11V13'));

// Line, from Hugeicons as drawn; Icon squares their ends and joins.
export const Activity = Activity01Icon;
export const Branch = GitBranchIcon;
export const Calendar = Calendar03Icon;
export const Chip = ChipIcon;
export const Code = ComputerTerminal01Icon;
export const Cube = CubeIcon;
export const DataBase = Database01Icon;
export const Document = File01Icon;
export const Filter = FilterHorizontalIcon;
export const Flow = Flowchart01Icon;
export const Folder = Folder01Icon;
export const Launch = LinkSquare02Icon;
export const Lightning = FlashIcon;
export const Meter = DashboardSpeed01Icon;
export const Moon = Moon02Icon;
export const OverflowMenuHorizontal = MoreHorizontalIcon;
export const ServerDns = ServerStack01Icon;
export const Sun = Sun03Icon;
export const Terminal = ComputerTerminal01Icon;
export const Undo = Undo02Icon;
export const ArrowsHorizontal = ArrowHorizontalIcon;
export const CollapseAll = UnfoldLessIcon;
export const ExpandAll = ArrowExpand01Icon;
export const Misuse = CancelCircleIcon;
export const TextWrap = TextWrapIcon;
export const Shrink = ArrowShrink01Icon;
// The mixing glyphs this app adds.
export const FolderOpen = FolderOpenIcon;
export const Grid = Grid3x3Icon;
export const Headphones = HeadphonesIcon;
export const Library = LibraryIcon;
export const Loading = Loading03Icon;
export const LowPass = FilterIcon;
export const Menu = Menu01Icon;
export const MusicNote = MusicNote01Icon;
export const Orbit = Orbit01Icon;
export const Sliders = SlidersHorizontalIcon;
export const Vinyl = Vynil01Icon;
export const Volume = VolumeHighIcon;

// Hugeicons sets round ends and joins on each element, over the svg's own; drop them so the square ones apply.
const squared = new WeakMap<SodiumIcon, SodiumIcon>();
function square(icon: SodiumIcon) {
  let out = squared.get(icon);
  if (!out) {
    out = icon.map(([tag, {strokeLinecap: _cap, strokeLinejoin: _join, ...attrs}]) => [tag, attrs] as const);
    squared.set(icon, out);
  }
  return out;
}

type IconProps = Omit<HugeiconsIconProps, 'icon' | 'size' | 'ref' | 'strokeWidth'> & {
  /** The glyph, imported from this file. */
  icon: SodiumIcon;
  /** px. 16 in a control (the default), 14 inside a small field, 20 on its own, 24 and 32 only for an empty state. */
  size?: 14 | 16 | 20 | 24 | 32;
  /** Accessible name. Without one the icon is decorative and hidden from assistive tech. */
  label?: string;
};

export function Icon({icon, size = 16, label, className, ...props}: IconProps) {
  return <HugeiconsIcon
    icon={square(icon)}
    size={size}
    strokeWidth={1.25}
    absoluteStrokeWidth
    strokeLinecap="square"
    strokeLinejoin="miter"
    aria-hidden={label ? undefined : true}
    aria-label={label}
    role={label ? 'img' : undefined}
    className={cn('shrink-0', className)}
    {...props}
  />;
}
