// ---------------------------------------------------------------------------
// Roguelite message types (Phase 2).
//
// Kept in a dedicated module (per the project's message-type convention) so new
// gameplay messages don't bloat the core `types.ts`. The raster client/server
// message unions in `types.ts` import and fold these in.
// ---------------------------------------------------------------------------

import type { PerkId } from "./perks.js";

/** Server → client: the perks a player may pick from this round. */
export interface PerkOfferPayload {
  /** Offered perk ids (length {@link PERK_OFFER_SIZE}). */
  options: PerkId[];
  /** 1-based round number, for the modal heading. */
  offerNumber: number;
}

/** Client → server: the perk the player chose from the latest offer. */
export interface PerkChosenPayload {
  perkId: PerkId;
}

/** Perk-related messages the server can send. */
export type PerkServerMessage = { type: "SERVER_PERK_OFFER"; payload: PerkOfferPayload };

/** Perk-related messages the client can send. */
export type PerkClientMessage = { type: "CLIENT_PERK_CHOSEN"; payload: PerkChosenPayload };
