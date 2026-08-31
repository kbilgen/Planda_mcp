/**
 * Fee resolution — collapse the API's `fee` / `custom_fee` pair into one
 * number before anything reaches the model.
 *
 * Planda returns two prices per service: `fee` is the service's platform
 * default (e.g. 3000), `custom_fee` is the therapist's own price when set
 * (e.g. 6000). The therapist's real price is `custom_fee ?? fee`. The
 * markdown renderer already applied that rule, but the raw pair still went
 * out through MCP `structuredContent` / JSON mode, and the model sometimes
 * quoted the default (3000 TL for Ekin Alankuş, whose real fee is 6000).
 *
 * After this pass every service carries exactly one `fee` and no
 * `custom_fee`, so no downstream consumer can pick the wrong one.
 */

import type { Service, Therapist } from "../types.js";

export function resolveEffectiveFee(s: Service): Service {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { custom_fee, ...rest } = s;
  return { ...rest, fee: custom_fee ?? s.fee ?? null };
}

export function resolveEffectiveFees(therapists: Therapist[]): Therapist[] {
  return therapists.map((t) =>
    t.services ? { ...t, services: t.services.map(resolveEffectiveFee) } : t
  );
}
