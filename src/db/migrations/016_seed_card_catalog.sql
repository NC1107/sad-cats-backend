-- 016: Seed card_sets and cat_cards catalog with all 50 cats

-- Card Sets
INSERT INTO card_sets (id, name, description, bonus_type, bonus_value) VALUES
  ('classic',      'Classic Cats',     'The original collection',    'all',       0.05),
  ('exotic',       'Exotic Breeds',    'Rare and unusual felines',   'passive',   0.08),
  ('candy',        'Candy Collection', 'Sweet as sugar',             'click',     0.08),
  ('retro',        'Retro Arcade',     'Pixel-perfect cats',         'auto',      0.10),
  ('supernatural', 'Supernatural',     'Beyond the mortal realm',    'all',       0.12),
  ('precious',     'Precious Metals',  'Worth their weight in gold', 'boss',      0.10)
ON CONFLICT (id) DO NOTHING;

-- Cat Cards (50 total)
INSERT INTO cat_cards (id, cat_name, sprite_file, rarity, set_id, buff_type, buff_value, fun_stats, description) VALUES
  -- Classic set (17 common, 5 uncommon)
  ('shadow',    'Shadow',    'black_0.png',      'common',   'classic', 'click',   0.02, '{"nap":8,"zoom":3,"chaos":5}',  'Lurks in dark corners, clicks with surgical precision.'),
  ('midnight',  'Midnight',  'black_1.png',      'common',   'classic', 'passive', 0.02, '{"nap":9,"zoom":2,"chaos":3}',  'Only appears after sundown. Purrs generate income while you sleep.'),
  ('void',      'Void',      'black_2.png',      'common',   'classic', 'click',   0.02, '{"nap":4,"zoom":7,"chaos":8}',  'Stares into the abyss. The abyss clicks back.'),
  ('onyx',      'Onyx',      'black_3.png',      'common',   'classic', 'passive', 0.02, '{"nap":6,"zoom":5,"chaos":4}',  'Polished and mysterious. Generates coins with quiet dignity.'),
  ('mocha',     'Mocha',     'brown_0.png',      'common',   'classic', 'passive', 0.02, '{"nap":7,"zoom":4,"chaos":3}',  'Warm and cozy. Generates coins as reliably as a morning coffee.'),
  ('chestnut',  'Chestnut',  'brown_1.png',      'common',   'classic', 'click',   0.02, '{"nap":5,"zoom":6,"chaos":4}',  'Sturdy and dependable. Every click counts double in spirit.'),
  ('hazel',     'Hazel',     'brown_2.png',      'common',   'classic', 'passive', 0.02, '{"nap":8,"zoom":3,"chaos":2}',  'Gentle eyes, steady income. The most reliable cat in the box.'),
  ('cocoa',     'Cocoa',     'brown_3.png',      'common',   'classic', 'click',   0.02, '{"nap":6,"zoom":5,"chaos":5}',  'Sweet but packs a punch. Clicks hit harder than expected.'),
  ('timber',    'Timber',    'brown_4.png',      'common',   'classic', 'boss',    0.02, '{"nap":4,"zoom":7,"chaos":6}',  'Built like a log cabin. Takes on bosses without flinching.'),
  ('walnut',    'Walnut',    'brown_5.png',      'common',   'classic', 'passive', 0.02, '{"nap":7,"zoom":4,"chaos":3}',  'Hard shell, soft heart. Quietly accumulates wealth.'),
  ('toffee',    'Toffee',    'brown_6.png',      'common',   'classic', 'all',     0.01, '{"nap":6,"zoom":5,"chaos":4}',  'Sticky sweet. A little bonus to everything.'),
  ('espresso',  'Espresso',  'brown_8.png',      'common',   'classic', 'click',   0.02, '{"nap":2,"zoom":9,"chaos":7}',  'Wired and ready. Clicks per second go through the roof.'),
  ('marmalade', 'Marmalade', 'orange_0.png',     'common',   'classic', 'click',   0.02, '{"nap":5,"zoom":7,"chaos":6}',  'Sweet and tangy. Clicks have that extra zest.'),
  ('ginger',    'Ginger',    'orange_3.png',     'common',   'classic', 'all',     0.01, '{"nap":6,"zoom":5,"chaos":5}',  'Spicy personality. A little boost to everything.'),
  ('ash',       'Ash',       'grey_0.png',       'common',   'classic', 'passive', 0.02, '{"nap":7,"zoom":4,"chaos":3}',  'Quiet and unassuming. Earns more than you''d expect.'),
  ('marble',    'Marble',    'white_grey_0.png', 'common',   'classic', 'click',   0.02, '{"nap":6,"zoom":5,"chaos":4}',  'Smooth and polished. Clicks roll in effortlessly.'),
  ('misty',     'Misty',     'white_grey_1.png', 'common',   'classic', 'passive', 0.02, '{"nap":8,"zoom":3,"chaos":2}',  'Appears in the fog. Passive income materializes from thin air.'),
  -- Classic uncommon
  ('teddy',     'Teddy',     'brown_7.png',      'uncommon', 'classic', 'passive', 0.03, '{"nap":9,"zoom":2,"chaos":1}',  'Everyone''s favorite. Generates extra income just by existing.'),
  ('blaze',     'Blaze',     'orange_1.png',     'uncommon', 'classic', 'click',   0.03, '{"nap":3,"zoom":9,"chaos":8}',  'On fire. Click power burns through everything.'),
  ('pumpkin',   'Pumpkin',   'orange_2.png',     'uncommon', 'classic', 'passive', 0.03, '{"nap":8,"zoom":3,"chaos":4}',  'Round and happy. Generates income like seeds in autumn.'),
  ('slate',     'Slate',     'grey_1.png',       'uncommon', 'classic', 'boss',    0.03, '{"nap":4,"zoom":7,"chaos":5}',  'Hard as rock. Boss damage increases significantly.'),
  ('smoke',     'Smoke',     'grey_2.png',       'uncommon', 'classic', 'click',   0.03, '{"nap":5,"zoom":6,"chaos":6}',  'Appears and vanishes. Clicks land like phantom strikes.'),
  ('snowball',  'Snowball',  'white_0.png',      'uncommon', 'classic', 'passive', 0.03, '{"nap":9,"zoom":2,"chaos":1}',  'Pure and pristine. Income accumulates like fresh snowfall.'),
  ('panther',   'Panther',   'black_4.png',      'uncommon', 'classic', 'boss',    0.03, '{"nap":3,"zoom":9,"chaos":7}',  'Built for the hunt. Deals extra damage to daily bosses.'),
  -- Precious set
  ('storm',     'Storm',     'blue_0.png',       'uncommon', 'precious', 'passive', 0.03, '{"nap":5,"zoom":7,"chaos":6}',  'Crackles with static electricity. Income surges follow.'),
  ('azure',     'Azure',     'blue_1.png',       'uncommon', 'precious', 'click',   0.03, '{"nap":7,"zoom":4,"chaos":3}',  'Cool and collected. Every click lands perfectly.'),
  ('cobalt',    'Cobalt',    'blue_2.png',       'uncommon', 'precious', 'all',     0.02, '{"nap":6,"zoom":5,"chaos":5}',  'A rare mineral cat. Boosts everything a little.'),
  ('navy',      'Navy',      'blue_3.png',       'uncommon', 'precious', 'passive', 0.03, '{"nap":8,"zoom":3,"chaos":2}',  'Disciplined and efficient. Passive income runs like clockwork.'),
  ('sunny',     'Sunny',     'yellow_0.png',     'uncommon', 'precious', 'all',     0.02, '{"nap":5,"zoom":7,"chaos":5}',  'Brightens every day. A warm boost to all income.'),
  ('ember',     'Ember',     'red_0.png',        'rare',     'precious', 'click',   0.04, '{"nap":3,"zoom":8,"chaos":7}',  'Still burning. Click power ignites on contact.'),
  ('crimson',   'Crimson',   'red_1.png',        'rare',     'precious', 'boss',    0.04, '{"nap":4,"zoom":7,"chaos":6}',  'Blood red and battle-ready. Boss damage amplified.'),
  ('reef',      'Reef',      'teal_0.png',       'rare',     'precious', 'passive', 0.04, '{"nap":7,"zoom":5,"chaos":4}',  'Ocean deep. Passive income flows like underwater currents.'),
  ('midas',     'Midas',     'gold_0.png',       'legendary','precious', 'all',     0.06, '{"nap":5,"zoom":5,"chaos":5}',  'Everything it touches turns to gold. The ultimate all-rounder.'),
  -- Exotic set
  ('vanilla',   'Vanilla',   'creme_0.png',      'uncommon', 'exotic', 'passive', 0.03, '{"nap":8,"zoom":3,"chaos":2}',  'Smooth and subtle. Income flows like cream.'),
  ('buttercup', 'Buttercup', 'creme_1.png',      'uncommon', 'exotic', 'click',   0.03, '{"nap":6,"zoom":6,"chaos":4}',  'Bright and cheerful. Clicks bloom with golden light.'),
  ('patches',   'Patches',   'calico_0.png',     'rare',     'exotic', 'all',     0.03, '{"nap":6,"zoom":6,"chaos":6}',  'A patchwork of power. Boosts everything equally.'),
  ('sphinx',    'Sphinx',    'hairless_0.png',   'rare',     'exotic', 'passive', 0.04, '{"nap":6,"zoom":5,"chaos":7}',  'Ancient wisdom in a modern package. Passive income from riddles.'),
  ('wrinkles',  'Wrinkles',  'hairless_1.png',   'rare',     'exotic', 'click',   0.04, '{"nap":5,"zoom":7,"chaos":8}',  'Each wrinkle holds a secret. Clicks powered by forbidden knowledge.'),
  ('siamese',   'Siamese',   'seal_point_0.png', 'rare',     'exotic', 'all',     0.03, '{"nap":6,"zoom":6,"chaos":5}',  'Elegant and vocal. Meows boost all income sources.'),
  -- Candy set
  ('blossom',   'Blossom',   'peach_0.png',            'rare', 'candy', 'passive', 0.04, '{"nap":8,"zoom":4,"chaos":3}',  'Delicate but productive. Income blooms like spring flowers.'),
  ('bubblegum', 'Bubblegum', 'pink_0.png',             'rare', 'candy', 'click',   0.04, '{"nap":4,"zoom":8,"chaos":6}',  'Pop! Each click bursts with sticky pink energy.'),
  ('bluebell',  'Bluebell',  'cotton_candy_blue_0.png','epic',  'candy', 'passive', 0.05, '{"nap":8,"zoom":5,"chaos":4}',  'Spun from sugar and dreams. Passive income tastes like cotton candy.'),
  ('rosebud',   'Rosebud',   'cotton_candy_pink_0.png','epic',  'candy', 'click',   0.05, '{"nap":5,"zoom":8,"chaos":4}',  'Pink perfection. Each click bursts with sweetness.'),
  -- Retro set
  ('pixel',     'Pixel',     'game_boy_0.png',   'rare',     'retro', 'click',   0.04, '{"nap":4,"zoom":8,"chaos":6}',  '8-bit legend. Clicks register with satisfying chiptune sounds.'),
  ('glitch',    'Glitch',    'game_boy_1.png',   'rare',     'retro', 'all',     0.03, '{"nap":3,"zoom":7,"chaos":10}', 'Corrupted but powerful. Randomly boosts everything.'),
  ('cartridge', 'Cartridge', 'game_boy_2.png',   'epic',     'retro', 'auto',    0.05, '{"nap":5,"zoom":6,"chaos":7}',  'Blow on it and it works. Auto-click speed dramatically increased.'),
  -- Supernatural set
  ('eclipse',   'Eclipse',   'dark_0.png',       'epic',     'supernatural', 'all',     0.04, '{"nap":3,"zoom":8,"chaos":9}',  'Blocks out the sun. All income multiplied in darkness.'),
  ('nebula',    'Nebula',    'indigo_0.png',     'epic',     'supernatural', 'passive', 0.05, '{"nap":7,"zoom":6,"chaos":5}',  'Born from stardust. Cosmic passive income generation.'),
  ('specter',   'Specter',   'ghost_0.png',      'legendary','supernatural', 'passive', 0.08, '{"nap":10,"zoom":1,"chaos":8}', 'Neither here nor there. Generates massive passive income from the beyond.'),
  ('isotope',   'Isotope',   'radioactive_0.png','mythic',   'supernatural', 'all',     0.10, '{"nap":1,"zoom":10,"chaos":10}','Glows in the dark. Mutated by cosmic rays, boosts everything massively.')
ON CONFLICT (id) DO NOTHING;
