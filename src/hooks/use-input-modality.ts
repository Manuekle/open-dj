"use client";

import { useEffect } from "react";

/* Marks the page with how the last control was reached, so the focus ring can follow it: Sodium rings every
   :focus-visible element, and a control focused by a press or a drag (a slider thumb takes focus from script) would
   otherwise keep its ring after the mouse. Tab brings the ring back; the play keys leave it as it was. */
export function useInputModality() {
  useEffect(() => {
    const root = document.documentElement;
    const set = (value: "pointer" | "keys") => { if (root.dataset.input !== value) root.dataset.input = value; };
    const onPointer = () => set("pointer");
    const onKey = (e: KeyboardEvent) => { if (e.key === "Tab") set("keys"); };
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("keydown", onKey, true);
      delete root.dataset.input;
    };
  }, []);
}
