/** Names that are not real property owners — must be replaced via county assessor lookup. */
const PLACEHOLDER_PATTERNS: RegExp[] = [
  /^fsbo\s+seller$/i,
  /^unknown\s*\(?craigslist\)?$/i,
  /^unknown\s*\(?/i,
  /^seller$/i,
  /^owner\s*unknown$/i,
  /^property\s+owner$/i,
  /^tax\s+sale/i,
  /^clay\s+county\s+tax\s+sale/i,
  /^n\/a$/i,
  /^none$/i,
  /^tbd$/i,
];

export function isPlaceholderOwner(name: string | null | undefined): boolean {
  const n = (name || "").trim();
  if (!n || n.length < 2) return true;
  return PLACEHOLDER_PATTERNS.some((re) => re.test(n));
}

/** Listing titles used as address — try to extract a street line for assessor lookup. */
export function extractAddressFromListing(text: string | null | undefined): string | null {
  if (!text?.trim()) return null;
  const t = text.trim();
  const street = t.match(
    /\b(\d+\s+(?:[NSEW]\.?\s+)?[A-Za-z0-9][\w\s.'-]{2,60}(?:\b(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Blvd|Ct|Court|Way|Pl|Place|Cir|Circle|Ter|Terrace|Hwy|Highway)\.?)\b)/i,
  )?.[1];
  if (street && street.length >= 6) return street.trim();
  if (/^\d+\s+[A-Za-z]/.test(t) && t.length <= 120) {
    const part = t.split(/[,|]/)[0]?.trim();
    return part && part.length >= 5 ? part : null;
  }
  return null;
}
