'use client';

import {createContext, useContext, type CSSProperties, type ReactNode} from 'react';
import {Meter as MeterPrimitive} from '@base-ui/react/meter';
import {cn, mergeClass} from '@/lib/sodium/utils';

// How full something is, inside a known range: a warehouse's credits against its quota, a disk, a queue against its
// limit. On Base UI Meter (role="meter"). For a task moving to done, use Progress.
//
// The bar is a square track with a 1px control edge (3:1), so its extent reads on any ground, and the fill runs from
// the start edge in sodium (--data-1): a data series, beside its label and its reading, never the only cue. A meter is
// a level, not an action, so the yellow here is the first data colour, the same one a chart's main series takes.
// Past warnAt the fill turns orange and past failAt red, and the reading says so with a word ("Near limit", "At
// limit"), never by hue alone. A tick crosses the track at each threshold inside the range, so trouble shows coming.
//
// Two sizes: 8px (--meter) and 6px, which leaves a 4px fill inside the edge. The label is a stat label (type-label-sm,
// text-2); the reading at the end is a stat value (type-code, as written, tabular), so readings line up down a stack
// of meters and match a status strip's and a data list's. The fill wipes to its new width, linear.
//
// MeterStack is the stacked line: one 4px line split into the parts of a whole (storage by table, credits by
// warehouse), each part a data colour with a 2px gap of the page between parts, and a key under it, each row a
// square in the part's colour, its name and its value. The line is a legend and a meter at once; the key carries
// every number, so no colour has to be told apart to read it.

type MeterStatus = 'warn' | 'fail';

const statusWords: Record<MeterStatus, string> = {warn: 'Near limit', fail: 'At limit'};

function meterStatus(fraction: number, warnAt: number | null, failAt: number | null): MeterStatus | undefined {
  if (failAt !== null && fraction >= failAt) return 'fail';
  if (warnAt !== null && fraction >= warnAt) return 'warn';
  return undefined;
}

const MeterContext = createContext<{status?: MeterStatus; statusLabel?: ReactNode}>({});

type MeterProps = Omit<MeterPrimitive.Root.Props, 'value'> & {
  value: number;
  /** The track's thickness: 8px by default, 6px small. */
  size?: 'default' | 'sm';
  /** The fraction of the range where it turns orange and draws a tick. null never warns. */
  warnAt?: number | null;
  /** The fraction where it turns red, with a tick when under 1. null never fails. */
  failAt?: number | null;
  /** The words after the reading past a threshold. "Near limit" and "At limit" by default. */
  statusLabel?: ReactNode;
};

function Meter({className, children, value, min = 0, max = 100, size = 'default', warnAt = 0.8, failAt = 1, statusLabel, ...props}: MeterProps) {
  const fraction = Math.min(Math.max((value - min) / (max - min || 1), 0), 1);
  const status = meterStatus(fraction, warnAt, failAt);
  const ticks = [warnAt, failAt].filter((t): t is number => t !== null && t > 0 && t < 1);
  return <MeterContext.Provider value={{status, statusLabel}}>
    <MeterPrimitive.Root
      data-slot="meter"
      data-size={size}
      data-status={status}
      value={value}
      min={min}
      max={max}
      locale="en-US"
      // The status words join what a screen reader hears: "92%, Near limit".
      getAriaValueText={(formatted: string | null) => [formatted, status ? (typeof statusLabel === 'string' ? statusLabel : statusWords[status]) : ''].filter(Boolean).join(', ')}
      className={mergeClass('group/meter flex w-full min-w-0 flex-wrap items-baseline gap-x-3 gap-y-2', className)}
      {...props}
    >
      {children}
      <span data-slot="meter-bar" className="relative block w-full basis-full">
        <MeterPrimitive.Track
          data-slot="meter-track"
          className={cn('relative block w-full overflow-hidden border border-line-control bg-page forced-colors:border-[CanvasText]', size === 'sm' ? 'h-1.5' : 'h-(--meter)')}
        >
          <MeterPrimitive.Indicator
            data-slot="meter-indicator"
            className={cn(
              'block h-full bg-data-1 transition-[width] duration-(--dur-wipe) ease-linear forced-colors:bg-[CanvasText]',
              'group-data-[status=warn]/meter:bg-warn group-data-[status=fail]/meter:bg-fail',
            )}
          />
        </MeterPrimitive.Track>
        {ticks.map(t => <span
          key={t}
          aria-hidden
          data-slot="meter-tick"
          className="absolute -inset-y-0.5 start-(--at) w-px bg-line-control"
          style={{'--at': `${t * 100}%`} as CSSProperties}
        />)}
      </span>
    </MeterPrimitive.Root>
  </MeterContext.Provider>;
}

/** What is measured, in mono capitals at the start of the row above the bar. */
function MeterLabel({className, ...props}: MeterPrimitive.Label.Props) {
  return <MeterPrimitive.Label data-slot="meter-label" className={mergeClass('min-w-0 flex-1 truncate type-label-sm text-text-2', className)} {...props}/>;
}

type MeterValueProps = Omit<MeterPrimitive.Value.Props, 'children'> & {
  /** Formats the reading: {(formatted, value) => `${value} / 500 TB`}. */
  children?: ((formattedValue: string, value: number) => ReactNode) | null;
};

/** The reading at the end of the row, as written in tabular mono. Past a threshold the status word comes first. */
function MeterValue({className, children, ...props}: MeterValueProps) {
  const {status, statusLabel} = useContext(MeterContext);
  return <span className={cn('ms-auto inline-flex shrink-0 items-baseline gap-2 type-code text-text-1', className as string)}>
    {status && <span data-slot="meter-status" className={cn('type-label-sm', status === 'fail' ? 'text-fail-text' : 'text-warn-text')}>{statusLabel ?? statusWords[status]}</span>}
    <MeterPrimitive.Value data-slot="meter-value" {...props}>{children ?? undefined}</MeterPrimitive.Value>
  </span>;
}

/** The series colours, in order: sodium, straw, khaki, umber, slate, cream. */
const series = ['bg-data-1', 'bg-data-2', 'bg-data-3', 'bg-data-4', 'bg-data-5', 'bg-data-6'] as const;

type MeterPart = {label: ReactNode; value: number; /** The display of the value; the number, grouped, by default. */ display?: ReactNode};

type MeterStackProps = Omit<React.ComponentProps<'div'>, 'children'> & {
  parts: MeterPart[];
  /** The whole. The sum of the parts by default; a larger max leaves the rest of the line empty. */
  max?: number;
  /** Names the whole: "Storage by table". */
  label: string;
  /** Hide the key, when a table beside the line already lists every part. */
  hideKey?: boolean;
};

/** One line split into the parts of a whole, with a key under it. Up to six parts, one per data colour. */
function MeterStack({className, parts, max, label, hideKey, ...props}: MeterStackProps) {
  const shown = parts.slice(0, series.length);
  const total = shown.reduce((sum, p) => sum + Math.max(0, p.value), 0);
  const whole = Math.max(max ?? total, total) || 1;
  const fmt = (n: number) => n.toLocaleString('en-US');
  return <div data-slot="meter-stack" role="group" aria-label={label} className={cn('flex w-full min-w-0 flex-col gap-3', className)} {...props}>
    <div data-slot="meter-stack-line" aria-hidden className="flex h-1 w-full gap-0.5 overflow-hidden">
      {shown.map((p, i) => p.value > 0 && <span
        key={i}
        data-slot="meter-stack-part"
        className={cn('h-full min-w-0.5 grow-(--grow) transition-[flex-grow] duration-(--dur-wipe) ease-linear forced-colors:bg-[CanvasText]', series[i])}
        style={{'--grow': p.value / whole} as CSSProperties}
      />)}
      {whole > total && <span data-slot="meter-stack-rest" className="h-full grow-(--grow) bg-well" style={{'--grow': (whole - total) / whole} as CSSProperties}/>}
    </div>
    {!hideKey && <ul data-slot="meter-stack-key" className="flex min-w-0 flex-col">
      {shown.map((p, i) => <li key={i} className="flex min-h-6 min-w-0 items-center gap-2">
        <span aria-hidden className={cn('size-(--marker) shrink-0 forced-colors:bg-[CanvasText]', series[i])}/>
        <span className="min-w-0 flex-1 truncate type-label-sm text-text-2">{p.label}</span>
        <span className="shrink-0 type-code text-text-1">{p.display ?? fmt(p.value)}</span>
      </li>)}
    </ul>}
  </div>;
}

export {Meter, MeterLabel, MeterValue, MeterStack, meterStatus, type MeterProps, type MeterValueProps, type MeterStackProps, type MeterPart, type MeterStatus};
