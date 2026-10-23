-- Counting: the 5 second cooldown switch becomes a wait in seconds, and
-- "start again after a wrong number" becomes one of three choices (start
-- again, back to the last checkpoint, keep going). Settings saved before
-- keep what they did: cooldown on = 5 seconds, reset off = keep going.

UPDATE bot_modules SET config = json_set(config,
        '$.cooldownSeconds', CASE WHEN json_extract(config, '$.cooldown') = 1 THEN 5 ELSE 0 END,
        '$.onFail', CASE WHEN json_extract(config, '$.resetOnFail') = 1 THEN 'reset' ELSE 'keep' END)
 WHERE module_key = 'counting'
   AND json_type(config, '$.onFail') IS NULL;

UPDATE bot_modules SET config = json_remove(config, '$.cooldown', '$.resetOnFail')
 WHERE module_key = 'counting';
