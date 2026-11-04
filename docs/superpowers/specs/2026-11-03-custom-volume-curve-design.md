# Custom transition volume curves

## Goal

Let the DJ shape the outgoing and incoming volume envelopes beyond the three fixed Smooth, Overlap, and Fade options, while keeping the preview faithful to what the audio engine will play.

## Design

- Keep Smooth, Overlap, and Fade as starting presets.
- Editing either envelope changes the transition to Custom and stores a normalized curve with the transition plan.
- The outgoing curve starts at full level and ends silent. The incoming curve starts silent and ends at full level. Interior points can be added by clicking the curve and moved horizontally to change timing or vertically to change gain from 0 to 100%.
- The editor draws both envelopes from the same curve data used by the audio engine.
- Audio automation remains scheduled on the Web Audio thread. The UI does not drive gain with render-rate updates.
- Existing projects without custom points keep their current preset behavior.
- Selecting a preset replaces custom points with that preset's curves.
- Curves remain part of a saved transition plan and are restored with the project.

## Scope

Only volume envelopes are customizable. EQ, filters, and effect parameters remain controlled by the existing settings and presets.

## Validation

- Check TypeScript and project lint.
- Inspect the transition editor at narrow and desktop widths.
- Verify that the visual curves and scheduled audio use the same curve data, and that old plans still resolve to their presets.
