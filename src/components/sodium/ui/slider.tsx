'use client';

import {DirectionProvider} from '@base-ui/react/direction-provider';
import {Slider as SliderPrimitive} from '@base-ui/react/slider';
import {useMemo, useRef} from 'react';
import {useDomDirection} from '@/lib/sodium/direction';
import {cn, mergeClass, mergeRefs} from '@/lib/sodium/utils';

// Sodium's slider, on Base UI's Slider. A 4px square track on the well, the range run along it in --check-range (dark
// gold in light, yellow in dark), and a 16px square thumb in the checked recipe: yellow with a gold edge in light, the
// dark yellow tint with a yellow edge in dark, lit from below and unlit while dragged. One thumb for a value, two for a range. Hover and drag lay a square wash around the
// thumb, --hover and --pressed, so the target grows without the thumb changing size.
//
// Focus lands on the thumb's hidden input, so the thumb draws the 2px ring with has-focus-visible.
//
// The read-out (showValue) prints the value through format, in mono as written with tabular figures, and reserves the
// width of its widest value: the longest of min, max, one step above min and one step below max sits invisible in the
// same grid cell, so the track never shifts while the thumb is dragged from 9 to 10 or from 99 to 100.
//
// Direction comes from the page: the slider reads it from its own box after mount and hands it to Base UI, so the range
// fills from the right under dir="rtl" and the arrow keys follow.

type SliderProps = SliderPrimitive.Root.Props & {
  /** Names each thumb for assistive tech, e.g. ['Minimum', 'Maximum']. One name per thumb. */
  thumbLabels?: string[];
  /** Shows the formatted value at the end of the track, with its width reserved. */
  showValue?: boolean;
};

function Slider({className, defaultValue, value, min = 0, max = 100, step = 1, thumbLabels, showValue, format, locale = 'en-US', ref, ...props}: SliderProps) {
  const values = useMemo(() => {
    const v = value ?? defaultValue;
    return Array.isArray(v) ? v : [v ?? min];
  }, [value, defaultValue, min]);
  const box = useRef<HTMLDivElement | null>(null);
  const boxRefs = useMemo(() => mergeRefs(box, ref), [ref]);
  const dir = useDomDirection(box);

  const fmt = useMemo(() => new Intl.NumberFormat(locale, format), [locale, format]);
  // Every digit is the same width in tabular figures, so the longest formatted candidate is the widest.
  const reserve = useMemo(() => {
    const longest = [min, max, Math.min(max, min + step), Math.max(min, max - step)]
      .map(n => fmt.format(n))
      .reduce((a, b) => (b.length > a.length ? b : a), '');
    return values.length > 1 ? `${longest} to ${longest}` : longest;
  }, [fmt, min, max, step, values.length]);

  return <DirectionProvider direction={dir}>
    <SliderPrimitive.Root
      ref={boxRefs}
      data-slot="slider"
      className={mergeClass('flex items-center gap-3 data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:flex-col', className)}
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      step={step}
      format={format}
      thumbAlignment="edge"
      // A fixed locale by default, so the server and the browser format the value the same way.
      locale={locale}
      {...props}
    >
      <SliderPrimitive.Control
        data-slot="slider-control"
        className="relative flex w-full touch-none items-center select-none data-[orientation=horizontal]:h-6 data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-40 data-[orientation=vertical]:w-6 data-[orientation=vertical]:flex-col data-disabled:cursor-not-allowed"
      >
        <SliderPrimitive.Track
          data-slot="slider-track"
          className="relative grow bg-well select-none data-[orientation=horizontal]:h-1 data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1 forced-colors:border forced-colors:border-solid forced-colors:border-[CanvasText]"
        >
          <SliderPrimitive.Indicator
            data-slot="slider-range"
            className="bg-check-range select-none data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full data-disabled:bg-text-disabled forced-colors:[forced-color-adjust:none] forced-colors:bg-[Highlight]"
          />
          {values.map((_, index) => <SliderPrimitive.Thumb
            data-slot="slider-thumb"
            key={index}
            index={index}
            getAriaLabel={thumbLabels ? i => thumbLabels[i] ?? '' : undefined}
            className={cn(
              'checked relative block size-4 shrink-0 cursor-grab select-none',
              // The wash: a 28px square of --hover around the thumb under the pointer, --pressed while dragged. It is
              // translucent ink, so over the thumb itself it barely shows. Also the hit area.
              'before:absolute before:-inset-1.5 before:transition-[background-color] before:duration-(--dur-state) before:ease-out',
              'hover:not-data-disabled:before:bg-hover data-dragging:cursor-grabbing data-dragging:before:bg-pressed',
              'has-focus-visible:focus-ring focus-visible:focus-ring',
              'data-disabled:cursor-not-allowed data-disabled:border-line data-disabled:bg-well',
              'forced-colors:[forced-color-adjust:none] forced-colors:border-[Canvas] forced-colors:bg-[CanvasText] forced-colors:data-disabled:bg-[GrayText]',
            )}
          />)}
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
      {showValue && <span data-slot="slider-value" className="grid shrink-0 justify-items-end type-code text-text-1 [grid-template-areas:'v']">
        <span aria-hidden data-slot="slider-value-reserve" className="invisible [grid-area:v]">{reserve}</span>
        <SliderPrimitive.Value className="[grid-area:v] data-disabled:text-text-disabled">
          {formatted => formatted.join(' to ')}
        </SliderPrimitive.Value>
      </span>}
    </SliderPrimitive.Root>
  </DirectionProvider>;
}

export {Slider, type SliderProps};
