-- Rename Midnight -> Moonlight
UPDATE cat_cards SET cat_name = 'Moonlight' WHERE id = 'midnight';

-- Redesign fun_stats with rarity-based budgets:
-- common=12-14, uncommon=15-17, rare=18-20, epic=21-23, legendary=24-26, mythic=28-30
-- Each cat has a dominant stat matching its personality

-- COMMON (12-14 total)
UPDATE cat_cards SET fun_stats = '{"nap":3,"zoom":7,"chaos":4}' WHERE id = 'shadow';      -- click/precision → zoom
UPDATE cat_cards SET fun_stats = '{"nap":8,"zoom":2,"chaos":3}' WHERE id = 'midnight';     -- sleep/passive → nap
UPDATE cat_cards SET fun_stats = '{"nap":2,"zoom":5,"chaos":7}' WHERE id = 'void';         -- abyss/chaos → chaos
UPDATE cat_cards SET fun_stats = '{"nap":6,"zoom":3,"chaos":4}' WHERE id = 'onyx';         -- quiet dignity → nap
UPDATE cat_cards SET fun_stats = '{"nap":7,"zoom":3,"chaos":2}' WHERE id = 'mocha';        -- cozy/reliable → nap
UPDATE cat_cards SET fun_stats = '{"nap":4,"zoom":5,"chaos":4}' WHERE id = 'chestnut';     -- sturdy → balanced
UPDATE cat_cards SET fun_stats = '{"nap":8,"zoom":2,"chaos":2}' WHERE id = 'hazel';        -- gentle/steady → nap
UPDATE cat_cards SET fun_stats = '{"nap":3,"zoom":6,"chaos":4}' WHERE id = 'cocoa';        -- packs a punch → zoom
UPDATE cat_cards SET fun_stats = '{"nap":2,"zoom":6,"chaos":6}' WHERE id = 'timber';       -- boss fighter → zoom/chaos
UPDATE cat_cards SET fun_stats = '{"nap":7,"zoom":2,"chaos":3}' WHERE id = 'walnut';       -- quiet wealth → nap
UPDATE cat_cards SET fun_stats = '{"nap":4,"zoom":4,"chaos":4}' WHERE id = 'toffee';       -- all bonus → balanced
UPDATE cat_cards SET fun_stats = '{"nap":1,"zoom":8,"chaos":4}' WHERE id = 'espresso';     -- wired/fast → zoom
UPDATE cat_cards SET fun_stats = '{"nap":3,"zoom":7,"chaos":3}' WHERE id = 'marmalade';    -- zesty clicks → zoom
UPDATE cat_cards SET fun_stats = '{"nap":5,"zoom":4,"chaos":4}' WHERE id = 'ginger';       -- spicy/all → balanced
UPDATE cat_cards SET fun_stats = '{"nap":7,"zoom":3,"chaos":3}' WHERE id = 'ash';          -- unassuming earner → nap
UPDATE cat_cards SET fun_stats = '{"nap":4,"zoom":6,"chaos":3}' WHERE id = 'marble';       -- smooth clicks → zoom
UPDATE cat_cards SET fun_stats = '{"nap":8,"zoom":2,"chaos":2}' WHERE id = 'misty';        -- fog/passive → nap

-- UNCOMMON (15-17 total)
UPDATE cat_cards SET fun_stats = '{"nap":2,"zoom":8,"chaos":7}' WHERE id = 'panther';      -- hunter/boss → zoom+chaos
UPDATE cat_cards SET fun_stats = '{"nap":4,"zoom":7,"chaos":5}' WHERE id = 'storm';        -- electric/passive → zoom
UPDATE cat_cards SET fun_stats = '{"nap":7,"zoom":5,"chaos":3}' WHERE id = 'azure';        -- cool/click → nap+zoom
UPDATE cat_cards SET fun_stats = '{"nap":5,"zoom":5,"chaos":5}' WHERE id = 'cobalt';       -- all-rounder → balanced
UPDATE cat_cards SET fun_stats = '{"nap":8,"zoom":4,"chaos":3}' WHERE id = 'navy';         -- disciplined → nap
UPDATE cat_cards SET fun_stats = '{"nap":9,"zoom":3,"chaos":3}' WHERE id = 'teddy';        -- favorite/passive → nap
UPDATE cat_cards SET fun_stats = '{"nap":8,"zoom":4,"chaos":3}' WHERE id = 'vanilla';      -- smooth/passive → nap
UPDATE cat_cards SET fun_stats = '{"nap":5,"zoom":6,"chaos":5}' WHERE id = 'buttercup';    -- cheerful clicks → zoom
UPDATE cat_cards SET fun_stats = '{"nap":2,"zoom":8,"chaos":7}' WHERE id = 'blaze';        -- on fire/click → zoom+chaos
UPDATE cat_cards SET fun_stats = '{"nap":8,"zoom":3,"chaos":4}' WHERE id = 'pumpkin';      -- happy/passive → nap
UPDATE cat_cards SET fun_stats = '{"nap":4,"zoom":6,"chaos":6}' WHERE id = 'smoke';        -- phantom clicks → zoom+chaos
UPDATE cat_cards SET fun_stats = '{"nap":3,"zoom":7,"chaos":6}' WHERE id = 'slate';        -- boss damage → zoom+chaos
UPDATE cat_cards SET fun_stats = '{"nap":9,"zoom":3,"chaos":3}' WHERE id = 'snowball';     -- pristine/passive → nap
UPDATE cat_cards SET fun_stats = '{"nap":4,"zoom":7,"chaos":5}' WHERE id = 'sunny';        -- bright/all → zoom

-- RARE (18-20 total)
UPDATE cat_cards SET fun_stats = '{"nap":6,"zoom":6,"chaos":6}' WHERE id = 'patches';      -- equal boost → balanced
UPDATE cat_cards SET fun_stats = '{"nap":4,"zoom":9,"chaos":6}' WHERE id = 'pixel';        -- 8-bit clicks → zoom
UPDATE cat_cards SET fun_stats = '{"nap":2,"zoom":7,"chaos":10}' WHERE id = 'glitch';      -- corrupted → chaos
UPDATE cat_cards SET fun_stats = '{"nap":7,"zoom":5,"chaos":7}' WHERE id = 'sphinx';       -- riddles/passive → nap+chaos
UPDATE cat_cards SET fun_stats = '{"nap":4,"zoom":8,"chaos":8}' WHERE id = 'wrinkles';     -- forbidden clicks → zoom+chaos
UPDATE cat_cards SET fun_stats = '{"nap":9,"zoom":5,"chaos":4}' WHERE id = 'blossom';      -- delicate bloom → nap
UPDATE cat_cards SET fun_stats = '{"nap":3,"zoom":9,"chaos":6}' WHERE id = 'bubblegum';    -- pop clicks → zoom
UPDATE cat_cards SET fun_stats = '{"nap":3,"zoom":9,"chaos":7}' WHERE id = 'ember';        -- burning clicks → zoom+chaos
UPDATE cat_cards SET fun_stats = '{"nap":3,"zoom":8,"chaos":8}' WHERE id = 'crimson';      -- battle boss → zoom+chaos
UPDATE cat_cards SET fun_stats = '{"nap":6,"zoom":7,"chaos":5}' WHERE id = 'siamese';      -- vocal/all → balanced+zoom
UPDATE cat_cards SET fun_stats = '{"nap":8,"zoom":5,"chaos":5}' WHERE id = 'reef';         -- ocean passive → nap

-- EPIC (21-23 total)
UPDATE cat_cards SET fun_stats = '{"nap":9,"zoom":6,"chaos":7}' WHERE id = 'bluebell';     -- sugar passive → nap
UPDATE cat_cards SET fun_stats = '{"nap":5,"zoom":9,"chaos":8}' WHERE id = 'rosebud';      -- sweet clicks → zoom+chaos
UPDATE cat_cards SET fun_stats = '{"nap":3,"zoom":8,"chaos":10}' WHERE id = 'eclipse';     -- darkness/all → chaos+zoom
UPDATE cat_cards SET fun_stats = '{"nap":6,"zoom":7,"chaos":9}' WHERE id = 'cartridge';    -- retro auto → chaos+zoom
UPDATE cat_cards SET fun_stats = '{"nap":8,"zoom":7,"chaos":7}' WHERE id = 'nebula';       -- cosmic passive → balanced high

-- LEGENDARY (24-26 total)
UPDATE cat_cards SET fun_stats = '{"nap":10,"zoom":5,"chaos":9}' WHERE id = 'specter';     -- ghost passive → nap+chaos
UPDATE cat_cards SET fun_stats = '{"nap":8,"zoom":8,"chaos":8}' WHERE id = 'midas';        -- golden all → balanced

-- MYTHIC (28-30 total)
UPDATE cat_cards SET fun_stats = '{"nap":3,"zoom":10,"chaos":10}' WHERE id = 'isotope';    -- radioactive → zoom+chaos extreme, but low nap (unstable)

-- NOTE: Also update CardCatalog.jsx frontend CARDS array to match
