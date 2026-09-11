export interface PageRange { from: number; to: number }

/** Page rendered pixel coordinates, honouring early breaks and keeping blocks
 * (or individual text lines in oversized blocks) together whenever they fit. */
export function paginate(
  contentHeight: number,
  pageHeight: number,
  breaks: (number | PageRange)[] = [],
  keepTogether: PageRange[] = [],
): PageRange[] {
  if (!Number.isFinite(contentHeight) || contentHeight <= 0 || !Number.isFinite(pageHeight) || pageHeight <= 0)
    return [{ from: 0, to: 0 }];
  const stops = breaks.map((value) => typeof value === "number" ? { from: value, to: value } : value)
    .filter((r) => Number.isFinite(r.from) && Number.isFinite(r.to) && r.from >= 0 && r.from < contentHeight && r.to >= r.from)
    .sort((a, b) => a.from - b.from);
  stops.push({ from: contentHeight, to: contentHeight });
  const blocks = keepTogether.filter((r) => Number.isFinite(r.from) && Number.isFinite(r.to) && r.to > r.from && r.to - r.from <= pageHeight);
  const pages: PageRange[] = [];
  let from = 0;
  for (const boundary of stops) {
    const stop = boundary.from;
    while (from < stop) {
      let to = Math.min(from + pageHeight, stop);
      // A manual boundary always wins. At a screen edge, back up to the start
      // of any overlapping block. Strict progress prevents oversized content
      // or overlapping layout boxes from creating empty/infinite pages.
      if (to < stop) {
        let previous: number;
        do {
          previous = to;
          for (const block of blocks) {
            if (block.from > from && block.from < to && block.to > to)
              to = block.from;
          }
        } while (to < previous);
      }
      pages.push({ from, to });
      from = to;
    }
    from = Math.max(from, Math.min(boundary.to, contentHeight));
  }
  return pages.length ? pages : [{ from: 0, to: 0 }];
}
