const { withTransaction } = require('../config/database');
const rpgModel = require('../models/rpg.model');
const rpgStats = require('../utils/rpgStats');
const logger = require('../utils/logger');
const { ValidationError } = require('../utils/errors');

/**
 * Shape one DB cat row into the API contract: derived stats, role, xp-to-next,
 * level cap, and lazily-regenerated stamina.
 */
function shapeCat(row, isMember) {
  const level = Number(row.level) || 1;
  const role = rpgStats.roleFor(row.buff_type);
  // Stamina is null until the cat's stat row exists; treat as full pool.
  let stamina = rpgStats.staminaCap(isMember);
  if (row.stamina != null && row.stamina_updated_at) {
    stamina = rpgStats.regenStamina(Number(row.stamina), row.stamina_updated_at, isMember).stamina;
  }
  return {
    playerCardId: row.player_card_id,
    cardId: row.card_id,
    catName: row.cat_name,
    spriteFile: row.sprite_file,
    rarity: row.rarity,
    setId: row.set_id,
    buffType: row.buff_type,
    buffValue: Number(row.buff_value) || 0,
    level,
    xp: Number(row.xp) || 0,
    xpToNext: rpgStats.xpToNext(level),
    levelCap: rpgStats.levelCap(row.rarity),
    stamina,
    staminaCap: rpgStats.staminaCap(isMember),
    role: role.role,
    special: role.special,
    stats: rpgStats.deriveStats(row, level),
  };
}

/**
 * One-time starter gift: grant each owned card an XP head-start scaled by how
 * long ago it was obtained, capped at the cumulative XP to reach level 4. Runs
 * once per player (guarded by rpg_starter_grants). Honors veteran collectors
 * without a balance-breaking head start.
 */
async function grantStarterGiftIfNeeded(discordId, rows) {
  const alreadyGranted = await rpgModel.hasStarterGrant(discordId);
  if (alreadyGranted) return rows;

  const giftCap = rpgStats.cumulativeXpToReach(4);
  const now = Date.now();

  await withTransaction(async (client) => {
    // Re-check inside the txn to close the double-grant race.
    if (await rpgModel.hasStarterGrant(discordId, client)) return;
    for (const row of rows) {
      const daysOwned = Math.max(0, Math.floor((now - new Date(row.obtained_at).getTime()) / 86400000));
      const totalXp = Math.min(giftCap, daysOwned * 8);
      if (totalXp <= 0) continue;
      const { level, xp } = rpgStats.resolveLevelFromTotalXp(totalXp, rpgStats.levelCap(row.rarity));
      if (level > 1 || xp > 0) {
        await rpgModel.setLevelXp(row.player_card_id, discordId, row.card_id, level, xp, client);
        row.level = level;
        row.xp = xp;
      }
    }
    await rpgModel.markStarterGrant(discordId, client);
  });

  return rows;
}

/**
 * GET /api/rpg/cats
 * All owned cats with derived stats, the active party, and rosterBonus.
 */
const getCats = async (req, res, next) => {
  try {
    const discordId = req.user.data.discordId;
    const isMember = !!req.user.data.isMember;

    let rows = await rpgModel.getCatRows(discordId);
    rows = await grantStarterGiftIfNeeded(discordId, rows);

    const cats = rows.map(r => shapeCat(r, isMember));
    const [partySlots, totalLevels] = await Promise.all([
      rpgModel.getPartySlots(discordId),
      rpgModel.getTotalCatLevels(discordId),
    ]);

    const party = [null, null, null, null];
    for (const { slot, player_card_id } of partySlots) party[slot] = player_card_id;

    res.json({
      success: true,
      cats,
      party,
      rosterBonus: rpgStats.rosterBonus(totalLevels),
      totalCatLevels: totalLevels,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/rpg/party
 * Just the 4 active slots (lighter than getCats).
 */
const getParty = async (req, res, next) => {
  try {
    const discordId = req.user.data.discordId;
    const [slots, totalLevels] = await Promise.all([
      rpgModel.getPartySlots(discordId),
      rpgModel.getTotalCatLevels(discordId),
    ]);
    const party = [null, null, null, null];
    for (const { slot, player_card_id } of slots) party[slot] = player_card_id;
    res.json({ success: true, party, rosterBonus: rpgStats.rosterBonus(totalLevels) });
  } catch (error) {
    next(error);
  }
};

/**
 * PUT /api/rpg/party
 * Replace the party. Body { slots: [uuid|null × 4] }. Validates ownership +
 * no-duplicate, then rewrites in a transaction (delete-then-insert).
 */
const setParty = async (req, res, next) => {
  try {
    const discordId = req.user.data.discordId;
    const { slots } = req.body;

    const present = slots.filter(Boolean);
    const unique = new Set(present);
    if (unique.size !== present.length) {
      throw new ValidationError('A cat cannot occupy two party slots');
    }

    const owned = await rpgModel.filterOwnedCardIds(discordId, present);
    const notOwned = present.filter(id => !owned.has(id));
    if (notOwned.length) {
      throw new ValidationError('Party includes a cat you do not own');
    }

    await withTransaction(async (client) => {
      await rpgModel.clearParty(discordId, client);
      for (let slot = 0; slot < slots.length; slot++) {
        if (slots[slot]) await rpgModel.insertPartySlot(discordId, slots[slot], slot, client);
      }
    });

    logger.info('Party updated', { discordId, filled: present.length });
    res.json({ success: true, party: slots });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getCats,
  getParty,
  setParty,
};
