// Input layer (pointer/keyboard normalization feeding the state machine).
// Intentionally empty in this session; the module boundary exists from day one.
// The vocabulary this layer will produce is #42's, in `../interaction/events.ts`.
// What #46 adds here is the *delivery*: a DOM event turned into one of those,
// and a scoped, remappable shortcut registry with no global listeners.
export {};
