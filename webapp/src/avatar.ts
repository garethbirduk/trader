// Initials + colour helpers. Skin-agnostic: picks letters from
// displayName (skipping "The" / "the") and a deterministic colour from
// the actor code so the same actor always shows the same swatch.

const STOP_WORDS = new Set(["the", "a", "an"]);

export function getInitials(displayName: string): string {
  const parts = displayName
    .split(/[\s\-']+/)
    .filter((p) => p.length > 0 && !STOP_WORDS.has(p.toLowerCase()));
  if (parts.length === 0) return displayName.slice(0, 2).toUpperCase();
  if (parts.length === 1) return parts[0]!.slice(0, 1).toUpperCase();
  return (parts[0]!.charAt(0) + parts[parts.length - 1]!.charAt(0)).toUpperCase();
}

const PALETTE = [
  "#6dd3a4",
  "#6db3d3",
  "#c089ff",
  "#ff9f4d",
  "#d3c46d",
  "#d36db3",
  "#6dd3d3",
  "#9aa6e8",
];

export function getActorColor(opts: { code: string; isPlayer: boolean }): string {
  if (opts.isPlayer) return "#ffb84d"; // accent
  let hash = 0;
  for (const ch of opts.code) {
    hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length]!;
}
