// A menu surface leaves on the frame it is dismissed: while Radix runs an exit
// animation the dismissable layer stays mounted, and a press that should open
// the next menu is swallowed as the dismissal of this one (DESIGN.md, Motion).
export const menuNoExit = "data-closed:animate-none!";
