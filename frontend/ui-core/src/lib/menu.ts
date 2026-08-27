// What every `DropdownMenuContent` call site adds to the canonical surface, in
// one constant because both halves are the same rule — a menu that behaves like
// a menu (DESIGN.md, Motion).
//
// `data-closed:animate-none!`: a menu surface leaves on the frame it is
// dismissed. While Radix runs an exit animation the dismissable layer stays
// mounted, and a press that should open the next menu is swallowed as the
// dismissal of this one.
//
// `w-auto`: a menu sizes to its items, not to its trigger. Canonical carries
// `w-(--radix-dropdown-menu-trigger-width) min-w-32`, which pins the surface to
// the trigger — behind an icon-sized button that is the 128px floor, and every
// item longer than that wraps (the row actions on ModelsScreen, the Annotate
// picker). `min-w-32` survives as the floor it was meant to be, because
// tailwind-merge replaces only the `w-*` in the same utility group.
export const menuSurface = "data-closed:animate-none! w-auto";
