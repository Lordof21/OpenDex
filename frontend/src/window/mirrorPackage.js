// The phone-mirror pseudo-app has used two package identifiers historically
//. Every place that needs "is this window the phone screen, not a
// real app" had re-implemented the same check independently and drifted
// between exact-match and startsWith — one shared check instead.
const MIRROR_PACKAGE_PREFIXES = ['com.opendex.screen_mirror', 'com.opendex.phone', 'com.android.internal.mirror'];

export function isMirrorPackage(pkg) {
  return MIRROR_PACKAGE_PREFIXES.some((prefix) => pkg?.startsWith(prefix));
}
