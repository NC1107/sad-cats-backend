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

module.exports = {
  setPartySchema,
};
