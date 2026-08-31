/**
 * Card-hold gate for /v1/assistant/chat/stream.
 *
 * Both provider paths deliver the model's answer to `onDelta` in one piece
 * (workflow.ts runChatStream), and the guards — hallucination, intent,
 * ladder — only run on the finished text. Forwarding that delta as-is means
 * iOS renders the raw answer, cards included, and then gets a `corrected`
 * event that swaps it out: the user sees therapist cards flash and vanish
 * whenever the ladder guard sends the model back a rung.
 *
 * The gate forwards ordinary conversational deltas immediately and holds
 * everything from the first card marker on. Held text is never lost — the
 * endpoint compares the final response against `streamed` and delivers the
 * whole verdict through `corrected` + `done`. Written delta-by-delta so it
 * keeps working if a provider ever streams tokens.
 */

/**
 * A card is either the `[[expert:username]]` tag the client renders from,
 * or the `**Ad Soyad** — Unvan` header the prompt puts above it (the header
 * comes first in the text, so waiting for the tag would leak name and fee).
 */
const CARD_MARKER = /\[\[expert:|^\*\*[^*\n]+\*\*\s*[—–-]/m;

export interface CardHold {
  /** Forward this delta (returned unchanged) or hold it (null). */
  push(delta: string): string | null;
  /** True once a card marker has been seen; stays true for the turn. */
  readonly held: boolean;
  /** Exactly what has been forwarded so far — compare the final text to this. */
  readonly streamed: string;
}

export function createCardHold(): CardHold {
  let seen = "";
  let streamed = "";
  let held = false;
  return {
    push(delta) {
      seen += delta;
      if (!held && CARD_MARKER.test(seen)) held = true;
      if (held) return null;
      streamed += delta;
      return delta;
    },
    get held() { return held; },
    get streamed() { return streamed; },
  };
}
