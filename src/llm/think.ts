/**
 * Streaming filter that drops <think>...</think> blocks some open models put in
 * the content stream. Handles tags split across chunks.
 */
export class ThinkStripper {
  private buf = "";
  private inside = false;

  push(chunk: string): string {
    this.buf += chunk;
    let out = "";
    for (;;) {
      if (this.inside) {
        const end = this.buf.indexOf("</think>");
        if (end === -1) {
          this.buf = this.buf.slice(Math.max(0, this.buf.length - "</think>".length + 1));
          return out;
        }
        this.buf = this.buf.slice(end + "</think>".length).replace(/^\s+/, "");
        this.inside = false;
      } else {
        const start = this.buf.indexOf("<think>");
        if (start === -1) {
          const keep = partialSuffix(this.buf, "<think>");
          out += this.buf.slice(0, this.buf.length - keep);
          this.buf = this.buf.slice(this.buf.length - keep);
          return out;
        }
        out += this.buf.slice(0, start);
        this.buf = this.buf.slice(start + "<think>".length);
        this.inside = true;
      }
    }
  }

  /** Flush anything held back as a possible partial tag once the stream ends. */
  end(): string {
    const rest = this.inside ? "" : this.buf;
    this.buf = "";
    return rest;
  }
}

function partialSuffix(s: string, tag: string): number {
  for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) {
    if (tag.startsWith(s.slice(s.length - n))) return n;
  }
  return 0;
}
