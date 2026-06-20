const { z } = require('zod');

// PUT /api/rpg/party — body { slots: [uuid|null × 4] }.
// .strip() drops unknown keys; no reward/xp/stamina fields are ever accepted
// from the client (those are server-authoritative). Exactly 4 slots; each is a
// player_card UUID or null (empty slot). Duplicate / ownership checks happen in
// the controller transaction, not here.
const setPartySchema = z.object({
  body: z.object({
    slots: z.array(z.string().uuid().nullable()).length(4, 'Party has exactly 4 slots'),
  }).strip(),
});

// POST /api/rpg/combat/start — body { encounterId }. The encounter is validated
// against the story catalog in the controller; here we only constrain the shape.
const startCombatSchema = z.object({
  body: z.object({
    encounterId: z.string().min(1).max(64),
  }).strip(),
});

// POST /api/rpg/dispatch/accept — { questId, playerCardIds }. Tier/eligibility
// checks happen in the controller; here we only constrain the shape.
const acceptDispatchSchema = z.object({
  body: z.object({
    questId: z.string().min(1).max(64),
    playerCardIds: z.array(z.string().uuid()).min(1).max(4),
  }).strip(),
});

module.exports = {
  setPartySchema,
  startCombatSchema,
  acceptDispatchSchema,
};
