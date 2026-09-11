# Architecture: direct building model

The default workflow edits connected building volumes. Walls, roofs, openings and
supports are derived from those volumes and their neighbours; individual wall
pieces and complete-building presets are secondary authoring tools.

## References inspected

- [Townscaper, developer/publisher description and gameplay](https://store.steampowered.com/app/1291340/Townscaper/): coloured blocks are placed on a grid and their configuration determines the resulting buildings, roofs and connecting structures. The relevant interaction is adding and removing occupied space while nearby architecture adapts.
- [Tiny Glade, developer description and gameplay](https://store.steampowered.com/app/2198150/Tiny_Glade/): freeform building, path-driven doorways, and supports that adapt when a building is raised. The reference clips show manipulation directly on the structure and path strokes changing wall apertures.
- [Townscaper browser demo by Oskar Stålberg](https://oskarstalberg.com/Townscaper/): primary reference for the block-building interaction, rather than a preset catalogue.

Local samples of the official gameplay clips are in the ignored
`artifacts/architecture-references/` directory. These references inform interaction
and geometry rules; their artwork and proprietary generation systems are not used.

## Authoring contract

| Action | Input | Result |
| --- | --- | --- |
| Building | Drag a footprint in the scene | An entire roofed building volume, with exterior surfaces derived automatically |
| Tower | Drag a round footprint | A circular building with an adapting roof |
| Grow | Click ground, wall or roof | Add a connected cell beside or above the hit surface; remove shared walls and covered roofs |
| Remove | Right-click a form, or use Erase | Remove the form and rebuild newly exposed neighbouring surfaces |
| Reshape | Select a form and drag its on-object handles | Change width, depth, body height, roof height, base elevation, placement or yaw, with a live result |
| Path | Draw through the scene | A path with automatic passages through intersected building walls |
| Window / Door | Click the facade | A real aperture at the cursor location |
| Paint | Click a form | Change its finish while retaining its geometry and connections |
| Terrain sculpt | Raise, lower, flatten or smooth the ground | Attached buildings follow vertically as connected structures; their clearances, stacks and openings remain intact |

All commands edit a serializable model on one Architecture root. Derived geometry
is not a hierarchy of hand-placed legacy walls or storeys. A complete gesture is
one undo entry; Escape cancels an unfinished gesture. The same model generates
the runtime mesh and collider after scene reload.

## Required verification

Verify shared-wall removal, rooftop replacement when stacking, exposed surfaces
after removal, circular geometry, holes that can be raycast through, path-driven
passages, and stable model round trips. Drive creation, growth, reshaping and undo
with real viewport input; checking only toolbar controls is insufficient.

The implementation uses its own geometry rules and a regular growth grid.
Townscaper's irregular grid, full decorative rule set and Tiny Glade's artwork,
weathering and ornamental variety are outside this interaction model.
