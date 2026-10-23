// The authorization context of the command that is running (set by requireScope in _shared/scope.mjs).
// The shared network and write paths consult it before EVERY request and write, not just at the start.
// Deliberately has no imports, so polite.mjs and common.mjs can use it without import cycles.
let active = null;

/** ctx = { path, request, scope, authorizeHop(url), recheck() } */
export function setActiveScope(ctx) { active = ctx; }
export function clearActiveScope() { active = null; }
export function activeScope() { return active; }
