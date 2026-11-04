"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, type SelectSize } from "@/components/sodium/ui/select";

type PickProps = {
  items: readonly { value: string; label: string }[];
  value: string | null;
  onValueChange: (value: string) => void;
  size?: SelectSize;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
};

/* Sodium's popup select as one element: trigger, value and list from a flat item array. */
export function Pick({ items, value, onValueChange, size = "sm", placeholder, disabled, className, "aria-label": label }: PickProps) {
  return <Select items={items} value={value} disabled={disabled} onValueChange={v => { if (v) onValueChange(v); }}>
    <SelectTrigger size={size} className={className} aria-label={label}>
      <SelectValue placeholder={placeholder}/>
    </SelectTrigger>
    <SelectContent size={size === "sm" ? "sm" : "default"}>
      {items.map(i => <SelectItem key={i.value} value={i.value}>{i.label}</SelectItem>)}
    </SelectContent>
  </Select>;
}
