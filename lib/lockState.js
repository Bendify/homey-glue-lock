'use strict';

/**
 * Maps a Glue lock event type to locked state.
 * @returns {boolean|null} true = locked, false = unlocked, null = unknown
 */
function lockedFromEvent(eventType) {
  if (!eventType) return null;
  const t = String(eventType).toLowerCase();
  if (t.includes('unlock')) return false;
  if (t.includes('lock') || t.includes('pressandgo')) return true;
  return null;
}

module.exports = { lockedFromEvent };
