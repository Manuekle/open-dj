"use client";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/sodium/ui/tooltip";

/** Names a control on hover and focus with Sodium's tooltip, and shows its keyboard shortcut when it has one. */
export function Hint({ label, keys, children }: { label: string; keys?: string; children: React.ReactElement }) {
  return <Tooltip>
    <TooltipTrigger render={children}/>
    <TooltipContent shortcut={keys}>{label}</TooltipContent>
  </Tooltip>;
}
