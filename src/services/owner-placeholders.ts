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

  const withSuffix = [
    ...t.matchAll(
      /\b(\d{1,5}\s+(?!(?:Acres?|unit|sq)\b)(?:[NSEW]\.?\s+)?(?:[\w.'-]+\s+){0,8}(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Blvd|Ct|Court|Way|Pl|Place|Cir|Circle|Ter|Terrace|Hwy|Highway|Pkwy|Parkway)\.?)\b/gi,
    ),
  ];
  if (withSuffix.length) {
    const matches = withSuffix
      .map((m) => m[1]!.trim())
      .filter((m) => m.length >= 6 && m.length <= 80);
    if (matches.length) return matches[matches.length - 1]!;
  }

  // "6915 Mountain View Dr" embedded in marketing copy without always matching above
  const embedded = t.match(
    /\b(\d+\s+(?:[NSEW]\.?\s+)?[A-Za-z][\w\s.'-]{2,40}\s+(?:Dr|Drive|St|Street|Rd|Road|Ave|Avenue|Ln|Lane|Blvd|Way|Ct|Court)\.?)\b/i,
  )?.[1];
  if (embedded && embedded.length >= 8) return embedded.trim();

  if (/^\d+\s+[A-Za-z]/.test(t) && t.length <= 120) {
    const part = t.split(/[,|]/)[0]?.trim();
    if (part && part.length >= 5 && part.length <= 80) return part;
  }

  return null;
}
