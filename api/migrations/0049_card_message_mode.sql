-- Welcome, Leave and Boost messages: text, embed or card is now one choice
-- (message mode "card"). Settings that had a card keep sending it: their
-- message switches to the card mode (its text becomes the caption).

UPDATE bot_modules SET config = json_set(config, '$.message.mode', 'card')
 WHERE module_key IN ('welcommer', 'leavemer')
   AND COALESCE(json_extract(config, '$.card'), '') <> ''
   AND json_type(config, '$.message') = 'object';

UPDATE bot_modules SET config = json_set(config, '$.firstMessage.mode', 'card')
 WHERE module_key = 'boost'
   AND COALESCE(json_extract(config, '$.card'), '') <> ''
   AND json_type(config, '$.firstMessage') = 'object';

UPDATE bot_modules SET config = json_set(config, '$.againMessage.mode', 'card')
 WHERE module_key = 'boost'
   AND COALESCE(json_extract(config, '$.card'), '') <> ''
   AND json_type(config, '$.againMessage') = 'object';
