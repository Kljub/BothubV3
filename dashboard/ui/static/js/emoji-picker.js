// Emoji picker of the dashboard (builder fields, module settings, message
// texts), laid out like the emoji menu of Discord: a header with the groups,
// then the bot's servers (their icons) and the bot (its avatar); search,
// skin tone, "Frequently used" (this browser), Done.
// window.BotHubEmojiPicker.open(anchor, opts):
//   onPick(value)  the chosen emoji ('' for "None")
//   multi          picks add up, the picker stays open
//   botId, bot     the bot and its {name, avatar} (default: [data-emoji-bot] of the page)
//   t              texts (default: the i18n-client island of the page)
//   clear          show "None" (default true)
// Server emojis come as <:name:id>, so they work in messages and buttons.
(function () {
  'use strict';

  // [group, "emoji name|emoji name|…"]: the names are searched (Unicode names).
  const EMOJI_SETS = [
    ["smileys", "😀 grinning face|😃 smiling face open mouth|😄 smiling face open mouth and smiling eyes|😁 grinning face smiling eyes|😆 smiling face open mouth and tightly-closed eyes|😅 smiling face open mouth and cold sweat|😂 face tears of joy|🤣 rolling on the floor laughing|😊 smiling face smiling eyes|😇 smiling face halo|🙂 slightly smiling face|😉 winking face|😍 smiling face heart-shaped eyes|🥰 smiling face smiling eyes and three hearts|😘 face throwing a kiss|😋 face savouring delicious food|😛 face stuck-out tongue|😜 face stuck-out tongue and winking eye|🤪 grinning face one large and one small eye|😎 smiling face sunglasses|🤩 grinning face star eyes|🥳 face party horn and party hat|😏 smirking face|😒 unamused face|😔 pensive face|😢 crying face|😭 loudly crying face|😤 face look of triumph|😡 pouting face|🤯 shocked face exploding head|😳 flushed face|🥺 face pleading eyes|😱 face screaming in fear|🤔 thinking face|🤫 face finger covering closed lips|🙄 face rolling eyes|😴 sleeping face|🤤 drooling face|😷 face medical mask|🤒 face thermometer|🤠 face cowboy hat|🤡 clown face|👻 ghost|💀 skull|👽 extraterrestrial alien|🤖 robot face|💩 pile of poo|😺 smiling cat face open mouth|😐 neutral face|😑 expressionless face|😶 face without mouth|🙃 upside-down face|🫠 melting face|🤗 hugging face|🤭 smiling face smiling eyes and hand covering mouth|🫢 face open eyes and hand over mouth|🫣 face peeking eye|🤐 zipper-mouth face|🤨 face one eyebrow raised|😬 grimacing face|🤥 lying face|😌 relieved face|😪 sleepy face|🤢 nauseated face|🤮 face open mouth vomiting|🤧 sneezing face|🥵 overheated face|🥶 freezing face|🥴 face uneven eyes and wavy mouth|😵 dizzy face|🤑 money-mouth face|🥸 disguised face|🧐 face monocle|😕 confused face|🫤 face diagonal mouth|😟 worried face|🙁 slightly frowning face|☹️ white frowning face|😮 face open mouth|😯 hushed face|😲 astonished face|🥱 yawning face|😩 weary face|😫 tired face|😖 confounded face|😣 persevering face|😞 disappointed face|😓 face cold sweat|😥 disappointed but relieved face|😰 face open mouth and cold sweat|😨 fearful face|😠 angry face|🤬 serious face symbols covering mouth|😈 smiling face horns|👿 imp|☠️ skull and crossbones|👹 japanese ogre|👺 japanese goblin|👾 alien monster|😸 grinning cat face smiling eyes|😹 cat face tears of joy|😻 smiling cat face heart-shaped eyes|😼 cat face wry smile|😽 kissing cat face closed eyes|🙀 weary cat face|😿 crying cat face|😾 pouting cat face|🙈 see-no-evil monkey|🙉 hear-no-evil monkey|🙊 speak-no-evil monkey"],
    ["people", "👋 waving hand sign|🤚 raised back of hand|✋ raised hand|🖖 raised hand part between middle and ring fingers|👌 ok hand sign|🤌 pinched fingers|✌️ victory hand|🤞 hand index and middle fingers crossed|🤟 i love you hand sign|🤘 sign of the horns|🤙 call me hand|👈 white left pointing backhand index|👉 white right pointing backhand index|👆 white up pointing backhand index|👇 white down pointing backhand index|☝️ white up pointing index|👍 thumbs up sign|👎 thumbs down sign|✊ raised fist|👊 fisted hand sign|👏 clapping hands sign|🙌 person raising both hands in celebration|👐 open hands sign|🤝 handshake|🙏 person folded hands|✍️ writing hand|💪 flexed biceps|🧠 brain|👀 eyes|👁️ eye|👅 tongue|👄 mouth|👶 baby|🧑 adult|👨 man|👩 woman|🧓 older adult|👮 police officer|🕵️ sleuth or spy|💂 guardsman|🥷 ninja|👷 construction worker|🤴 prince|👸 princess|🧙 mage|🧚 fairy|🧛 vampire|🧜 merperson|🫶 heart hands|🫡 saluting face|🫵 index pointing at the viewer|💅 nail polish|🦾 mechanical arm|🦿 mechanical leg|🦵 leg|🦶 foot|👂 ear|🦻 ear hearing aid|👃 nose|🧒 child|👦 boy|👧 girl|🧔 bearded person|👱 person blond hair|👴 older man|👵 older woman|🙍 person frowning|🙎 person pouting face|🙅 face no good gesture|🙆 face ok gesture|💁 information desk person|🙋 happy person raising one hand|🧏 deaf person|🙇 person bowing deeply|🤦 face palm|🤷 shrug|🧑‍⚕️ adult staff of aesculapius|🧑‍🎓 adult graduation cap|🧑‍🏫 adult school|🧑‍💻 adult personal computer|🧑‍🎤 adult microphone|🧑‍🎨 adult artist palette|🧑‍🚀 adult rocket|🧑‍🍳 adult cooking|🦸 superhero|🦹 supervillain|💃 dancer|🕺 man dancing|👯 woman bunny ears|🧘 person in lotus position|🛀 bath|👫 man and woman holding hands|👪 family|🗣️ speaking head in silhouette|👤 bust in silhouette|👥 busts in silhouette"],
    ["nature", "🐶 dog face|🐱 cat face|🐭 mouse face|🐹 hamster face|🐰 rabbit face|🦊 fox face|🐻 bear face|🐼 panda face|🐨 koala|🐯 tiger face|🦁 lion face|🐮 cow face|🐷 pig face|🐸 frog face|🐵 monkey face|🐔 chicken|🐧 penguin|🐦 bird|🦆 duck|🦅 eagle|🦉 owl|🐺 wolf face|🐴 horse face|🦄 unicorn face|🐝 honeybee|🦋 butterfly|🐌 snail|🐞 lady beetle|🐢 turtle|🐍 snake|🐙 octopus|🦈 shark|🐬 dolphin|🐳 spouting whale|🌲 evergreen tree|🌴 palm tree|🌵 cactus|🌷 tulip|🌹 rose|🌻 sunflower|🍀 four leaf clover|🍁 maple leaf|🍄 mushroom|🌍 earth globe europe-africa|🌙 crescent moon|⭐ white medium star|🌟 glowing star|☀️ black sun rays|⛅ sun behind cloud|🌈 rainbow|❄️ snowflake|🔥 fire|💧 droplet|🌊 water wave|🐗 boar|🐛 bug|🐜 ant|🪲 beetle|🕷️ spider|🦂 scorpion|🦖 t-rex|🦕 sauropod|🦀 crab|🦞 lobster|🦐 shrimp|🦑 squid|🐠 tropical fish|🐟 fish|🐡 blowfish|🐊 crocodile|🐅 tiger|🐆 leopard|🦓 zebra face|🦍 gorilla|🐘 elephant|🦛 hippopotamus|🦏 rhinoceros|🐪 dromedary camel|🦒 giraffe face|🦘 kangaroo|🐃 water buffalo|🐂 ox|🐄 cow|🐎 horse|🐖 pig|🐏 ram|🐑 sheep|🦙 llama|🐐 goat|🦌 deer|🐕 dog|🐩 poodle|🐈 cat|🐓 rooster|🦃 turkey|🦚 peacock|🦜 parrot|🦢 swan|🕊️ dove of peace|🐇 rabbit|🦝 raccoon|🦨 skunk|🦡 badger|🦦 otter|🦥 sloth|🐁 mouse|🐀 rat|🐿️ chipmunk|🦔 hedgehog|🐾 paw prints|🐉 dragon|🌳 deciduous tree|🌱 seedling|🌿 herb|☘️ shamrock|🍃 leaf fluttering in wind|🍂 fallen leaf|🌾 ear of rice|🌺 hibiscus|🌸 cherry blossom|🌼 blossom|🪴 potted plant|🌕 full moon symbol|🌑 new moon symbol|☄️ comet|🌪️ cloud tornado|⚡ high voltage sign|☔ umbrella rain drops|⛄ snowman without snow"],
    ["food", "🍏 green apple|🍎 red apple|🍐 pear|🍊 tangerine|🍋 lemon|🍌 banana|🍉 watermelon|🍇 grapes|🍓 strawberry|🍒 cherries|🍑 peach|🥭 mango|🍍 pineapple|🥥 coconut|🥝 kiwifruit|🍅 tomato|🥑 avocado|🥦 broccoli|🌽 ear of maize|🥕 carrot|🍞 bread|🧀 cheese wedge|🥚 egg|🍳 cooking|🥓 bacon|🍔 hamburger|🍟 french fries|🍕 slice of pizza|🌭 hot dog|🌮 taco|🍣 sushi|🍜 steaming bowl|🍩 doughnut|🍪 cookie|🎂 birthday cake|🍰 shortcake|🍫 chocolate bar|🍬 candy|🍭 lollipop|🍿 popcorn|☕ hot beverage|🍵 teacup without handle|🥤 cup straw|🍺 beer mug|🍷 wine glass|🍹 tropical drink|🥐 croissant|🥖 baguette bread|🥨 pretzel|🥯 bagel|🥞 pancakes|🧇 waffle|🍖 meat on bone|🍗 poultry leg|🥩 cut of meat|🌯 burrito|🥙 stuffed flatbread|🧆 falafel|🥗 green salad|🍝 spaghetti|🍲 pot of food|🍛 curry and rice|🍱 bento box|🥟 dumpling|🍤 fried shrimp|🍙 rice ball|🍚 cooked rice|🍘 rice cracker|🍥 fish cake swirl design|🥠 fortune cookie|🍢 oden|🍡 dango|🍧 shaved ice|🍨 ice cream|🍦 soft ice cream|🥧 pie|🧁 cupcake|🍮 custard|🍯 honey pot|🥛 glass of milk|🧃 beverage box|🧋 bubble tea|🍶 sake bottle and cup|🍾 bottle popping cork|🍸 cocktail glass|🥂 clinking glasses|🥃 tumbler glass|🧊 ice cube|🥄 spoon|🍴 fork and knife|🍽️ fork and knife plate"],
    ["activities", "⚽ soccer ball|🏀 basketball and hoop|🏈 american football|⚾ baseball|🎾 tennis racquet and ball|🏐 volleyball|🏉 rugby football|🎱 billiards|🏓 table tennis paddle and ball|🏸 badminton racquet and shuttlecock|🥊 boxing glove|🥋 martial arts uniform|⛳ flag in hole|🎣 fishing pole and fish|🎿 ski and ski boot|🏂 snowboarder|🏆 trophy|🥇 first place medal|🥈 second place medal|🥉 third place medal|🏅 sports medal|🎖️ military medal|🎗️ reminder ribbon|🎫 ticket|🎟️ admission tickets|🎪 circus tent|🎭 performing arts|🎨 artist palette|🎬 clapper board|🎤 microphone|🎧 headphone|🎼 musical score|🎹 musical keyboard|🥁 drum drumsticks|🎷 saxophone|🎺 trumpet|🎸 guitar|🎻 violin|🎲 game die|♟️ black chess pawn|🎯 direct hit|🎳 bowling|🎮 video game|🕹️ joystick|🧩 jigsaw puzzle piece|🥅 goal net|🏒 ice hockey stick and puck|🏑 field hockey stick and ball|🏏 cricket bat and ball|🥍 lacrosse stick and ball|🪃 boomerang|🛹 skateboard|🛼 roller skate|🛷 sled|⛸️ ice skate|🥌 curling stone|🏋️ weight lifter|🤸 person doing cartwheel|⛹️ person ball|🤺 fencer|🤾 handball|🏌️ golfer|🏇 horse racing|🧗 person climbing|🚴 bicyclist|🏊 swimmer|🤽 water polo|🚣 rowboat|🏄 surfer|🎰 slot machine|🧸 teddy bear|🪀 yo-yo|🎴 flower playing cards|🃏 playing card black joker|🀄 mahjong tile red dragon"],
    ["travel", "🚗 automobile|🚕 taxi|🚌 bus|🏎️ racing car|🚓 police car|🚑 ambulance|🚒 fire engine|🚚 delivery truck|🚜 tractor|🏍️ racing motorcycle|🚲 bicycle|🛴 scooter|🚂 steam locomotive|✈️ airplane|🚀 rocket|🛸 flying saucer|🚁 helicopter|⛵ sailboat|🚢 ship|⚓ anchor|🗺️ world map|🗽 statue of liberty|🗼 tokyo tower|🏰 european castle|🏯 japanese castle|🏟️ stadium|🎡 ferris wheel|🎢 roller coaster|🏖️ beach umbrella|🏝️ desert island|🏔️ snow capped mountain|🌋 volcano|🏠 house building|🏢 office building|🏥 hospital|🏦 bank|🏫 school|⛪ church|🕌 mosque|⛩️ shinto shrine|🌃 night stars|🌆 cityscape at dusk|🌉 bridge at night|🚙 recreational vehicle|🛻 pickup truck|🚐 minibus|🚛 articulated lorry|🛵 motor scooter|🚨 police cars revolving light|🚔 oncoming police car|🚍 oncoming bus|🚘 oncoming automobile|🚖 oncoming taxi|🚡 aerial tramway|🚠 mountain cableway|🚟 suspension railway|🚃 railway car|🚋 tram car|🚞 mountain railway|🚝 monorail|🚄 high-speed train|🚅 high-speed train bullet nose|🚈 light rail|🚉 station|🛩️ small airplane|🛫 airplane departure|🛬 airplane arriving|🪂 parachute|💺 seat|🛰️ satellite|🚤 speedboat|🛥️ motor boat|⛴️ ferry|🛳️ passenger ship|⛽ fuel pump|🚧 construction sign|🚦 vertical traffic light|🚥 horizontal traffic light|🏕️ camping|⛺ tent|🏜️ desert|🏞️ national park|🗻 mount fuji|🌅 sunrise|🌄 sunrise over mountains|🌠 shooting star|🎆 fireworks|🎇 firework sparkler|🏙️ cityscape"],
    ["objects", "⌚ watch|📱 mobile phone|💻 personal computer|⌨️ keyboard|🖥️ desktop computer|🖨️ printer|🖱️ three button mouse|💾 floppy disk|💿 optical disc|📷 camera|🎥 movie camera|📺 television|📻 radio|⏰ alarm clock|⏳ hourglass flowing sand|🔋 battery|🔌 electric plug|💡 electric light bulb|🔦 electric torch|🕯️ candle|💸 money wings|💵 banknote dollar sign|💰 money bag|💳 credit card|💎 gem stone|⚖️ scales|🔧 wrench|🔨 hammer|⚒️ hammer and pick|🛠️ hammer and wrench|⚙️ gear|🔩 nut and bolt|🧲 magnet|🔫 pistol|💣 bomb|🔪 hocho|🛡️ shield|🔮 crystal ball|🧿 nazar amulet|💈 barber pole|🔭 telescope|🔬 microscope|💊 pill|💉 syringe|🧬 dna double helix|🧹 broom|🧺 basket|🎁 wrapped present|🎈 balloon|🎉 party popper|🎊 confetti ball|✉️ envelope|📦 package|📝 memo|📌 pushpin|📎 paperclip|🔒 lock|🔓 open lock|🔑 key|🗝️ old key|📢 public address loudspeaker|📣 cheering megaphone|🔔 bell|🔕 bell cancellation stroke|📅 calendar|📊 bar chart|📈 chart upwards trend|📉 chart downwards trend|📞 telephone receiver|☎️ black telephone|📟 pager|📠 fax machine|🎙️ studio microphone|🎚️ level slider|🎛️ control knobs|🧭 compass|⏱️ stopwatch|⏲️ timer clock|🕰️ mantelpiece clock|📡 satellite antenna|🪫 low battery|🧯 fire extinguisher|🛢️ oil drum|💶 banknote euro sign|💷 banknote pound sign|💴 banknote yen sign|🪙 coin|🧾 receipt|🔗 link symbol|⛓️ chains|🧰 toolbox|🪛 screwdriver|🪚 carpentry saw|🪓 axe|🏹 bow and arrow|🪤 mouse trap|🗡️ dagger knife|⚔️ crossed swords|🪄 magic wand|🧪 test tube|🧫 petri dish|🌡️ thermometer|🩹 adhesive bandage|🩺 stethoscope|🚪 door|🛏️ bed|🛋️ couch and lamp|🚽 toilet|🚿 shower|🛁 bathtub|🧴 lotion bottle|🧷 safety pin|🧽 sponge|🪣 bucket|🧻 roll of paper|🪥 toothbrush|🧼 bar of soap|📚 books|📖 open book|📰 newspaper|🗞️ rolled-up newspaper|📒 ledger|📕 closed book|📗 green book|📘 blue book|📙 orange book|🔖 bookmark|🏷️ label|✏️ pencil|🖊️ lower left ballpoint pen|🖌️ lower left paintbrush|🖍️ lower left crayon|📁 file folder|📂 open file folder|📋 clipboard|📍 round pushpin|✂️ black scissors|🗑️ wastebasket|🔍 left-pointing magnifying glass|🔎 right-pointing magnifying glass"],
    ["symbols", "❤️ heavy black heart|🧡 orange heart|💛 yellow heart|💚 green heart|💙 blue heart|💜 purple heart|🖤 black heart|🤍 white heart|🤎 brown heart|💔 broken heart|❣️ heavy heart exclamation mark ornament|💕 two hearts|💞 revolving hearts|💓 beating heart|💗 growing heart|💖 sparkling heart|💘 heart arrow|💝 heart ribbon|☮️ peace symbol|✝️ latin cross|☪️ star and crescent|🕉️ om symbol|☯️ yin yang|♈ aries|♉ taurus|♊ gemini|⛎ ophiuchus|🆔 squared id|⚛️ atom symbol|☢️ radioactive sign|☣️ biohazard sign|✅ white heavy check mark|☑️ ballot box check|✔️ heavy check mark|❌ cross mark|❎ negative squared cross mark|➕ heavy plus sign|➖ heavy minus sign|➗ heavy division sign|✖️ heavy multiplication x|♾️ permanent paper sign|‼️ double exclamation mark|⁉️ exclamation question mark|❓ black question mark ornament|❔ white question mark ornament|❕ white exclamation mark ornament|❗ heavy exclamation mark symbol|〰️ wavy dash|⚠️ warning sign|🚫 no entry sign|⛔ no entry|🔞 no one under eighteen symbol|💯 hundred points symbol|🔅 low brightness symbol|🔆 high brightness symbol|🔱 trident emblem|⚜️ fleur-de-lis|🔰 japanese symbol for beginner|♻️ black universal recycling symbol|🌐 globe meridians|💠 diamond shape a dot inside|Ⓜ️ circled latin capital letter m|🌀 cyclone|💤 sleeping symbol|🏧 automated teller machine|🚾 water closet|♿ wheelchair symbol|🅿️ negative squared latin capital letter p|🔤 input symbol for latin letters|🆗 squared ok|🆙 squared up exclamation mark|🆒 squared cool|🆕 squared new|🆓 squared free|0️⃣ digit zero|1️⃣ digit one|2️⃣ digit two|3️⃣ digit three|4️⃣ digit four|5️⃣ digit five|6️⃣ digit six|7️⃣ digit seven|8️⃣ digit eight|9️⃣ digit nine|🔟 keycap ten|▶️ black right-pointing triangle|⏸️ double vertical bar|⏹️ black square for stop|⏺️ black circle for record|⏭️ black right-pointing double triangle vertical bar|⏮️ black left-pointing double triangle vertical bar|⏩ black right-pointing double triangle|⏪ black left-pointing double triangle|🔀 twisted rightwards arrows|🔁 clockwise rightwards and leftwards open circle arrows|🔂 clockwise rightwards and leftwards open circle arrows circled one overlay|◀️ black left-pointing triangle|🔼 up-pointing small red triangle|🔽 down-pointing small red triangle|➡️ black rightwards arrow|⬅️ leftwards black arrow|⬆️ upwards black arrow|⬇️ downwards black arrow|↗️ north east arrow|↘️ south east arrow|↙️ south west arrow|↖️ north west arrow|↕️ up down arrow|↔️ left right arrow|🔄 anticlockwise downwards and upwards open circle arrows|🔃 clockwise downwards and upwards open circle arrows|🎵 musical note|🎶 multiple musical notes|💲 heavy dollar sign|©️ copyright sign|®️ registered sign|™️ trade mark sign|🔘 radio button|🔴 large red circle|🟠 large orange circle|🟡 large yellow circle|🟢 large green circle|🔵 large blue circle|🟣 large purple circle|⚫ medium black circle|⚪ medium white circle|🟥 large red square|🟧 large orange square|🟨 large yellow square|🟩 large green square|🟦 large blue square|🟪 large purple square|⬛ black large square|⬜ white large square|🔶 large orange diamond|🔷 large blue diamond|🔸 small orange diamond|🔹 small blue diamond|🔺 up-pointing red triangle|🔻 down-pointing red triangle|🛑 octagonal sign|💢 anger symbol|♨️ hot springs|💮 white flower|🉐 circled ideograph advantage|㊙️ circled ideograph secret|㊗️ circled ideograph congratulation|🈴 squared cjk unified ideograph-5408|🈵 squared cjk unified ideograph-6e80|🈹 squared cjk unified ideograph-5272|🈲 squared cjk unified ideograph-7981|🅰️ negative squared latin capital letter a|🅱️ negative squared latin capital letter b|🆎 negative squared ab|🆑 squared cl|🅾️ negative squared latin capital letter o|🆘 squared sos|❇️ sparkle|✳️ eight spoked asterisk|#️⃣ number sign|*️⃣ asterisk|⏏️ eject symbol|⏯️ black right-pointing triangle double vertical bar|➰ curly loop|➿ double curly loop|✴️ eight pointed black star|📛 name badge|⭕ heavy large circle|🔲 black square button|🔳 white square button|▪️ black small square|▫️ white small square|◾ black medium small square|◽ white medium small square|◼️ black medium square|◻️ white medium square|🟫 large brown square|🟤 large brown circle|💬 speech balloon|💭 thought balloon|🗯️ right anger bubble|🔊 speaker three sound waves|🔉 speaker one sound wave|🔈 speaker|🔇 speaker cancellation stroke"],
    ["flags", "🏁 chequered flag|🚩 triangular flag on post|🎌 crossed flags|🏴 waving black flag|🏳️ waving white flag|🏳️‍🌈 waving white flag rainbow|🏴‍☠️ waving black flag skull and crossbones|🇩🇪 flag de|🇦🇹 flag at|🇨🇭 flag ch|🇬🇧 flag gb|🇺🇸 flag us|🇫🇷 flag fr|🇮🇹 flag it|🇪🇸 flag es|🇳🇱 flag nl|🇵🇱 flag pl|🇹🇷 flag tr|🇺🇦 flag ua|🇷🇺 flag ru|🇯🇵 flag jp|🇰🇷 flag kr|🇨🇳 flag cn|🇧🇷 flag br|🇨🇦 flag ca|🇦🇺 flag au|🇪🇺 flag eu|🇧🇪 flag be|🇩🇰 flag dk|🇸🇪 flag se|🇳🇴 flag no|🇫🇮 flag fi|🇮🇪 flag ie|🇵🇹 flag pt|🇬🇷 flag gr|🇨🇿 flag cz|🇸🇰 flag sk|🇭🇺 flag hu|🇷🇴 flag ro|🇧🇬 flag bg|🇭🇷 flag hr|🇷🇸 flag rs|🇸🇮 flag si|🇱🇺 flag lu|🇮🇸 flag is|🇲🇽 flag mx|🇦🇷 flag ar|🇨🇱 flag cl|🇨🇴 flag co|🇮🇳 flag in|🇮🇩 flag id|🇹🇭 flag th|🇻🇳 flag vn|🇵🇭 flag ph|🇸🇬 flag sg|🇿🇦 flag za|🇪🇬 flag eg|🇳🇬 flag ng|🇮🇱 flag il|🇸🇦 flag sa|🇦🇪 flag ae|🇳🇿 flag nz|🇺🇳 flag un"],
  ];

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const pageTexts = () => {
    try { return JSON.parse(document.getElementById('i18n-client')?.textContent || '{}'); } catch { return {}; }
  };
  const defaultT = (key) => pageTexts()[key] || key;
  const pageBot = () => {
    const d = document.querySelector('[data-emoji-bot]')?.dataset || {};
    return { id: d.emojiBot || '', name: d.name || '', avatar: d.avatar || '' };
  };
  const store = {
    get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
    set(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode */ } },
  };

  // Group icons of the header (like the emoji menu of Discord).
  const GROUP_ICON = { smileys: '😀', people: '👋', nature: '🐶', food: '🍔', activities: '⚽', travel: '🚗', objects: '💡', symbols: '🔣', flags: '🏁' };
  const GROUPS = EMOJI_SETS.map(([key, data]) => [key, data.split('|').map((x) => {
    const i = x.indexOf(' ');
    return { e: x.slice(0, i), name: x.slice(i + 1) };
  })]);

  // Skin tones: people and hands that take a tone modifier.
  const TONES = ['', '\u{1F3FB}', '\u{1F3FC}', '\u{1F3FD}', '\u{1F3FE}', '\u{1F3FF}'];
  const TONE_BASE = new Set('👋 🤚 ✋ 🖖 👌 🤌 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👍 👎 ✊ 👊 👏 🙌 👐 🙏 ✍️ 💪 🫶 🫵 💅 🦵 🦶 👂 🦻 👃 👶 🧒 👦 👧 🧑 👨 👩 🧓 👴 👵 🧔 👱 👮 🕵️ 💂 🥷 👷 🤴 👸 🧙 🧚 🧛 🧜 🙍 🙎 🙅 🙆 💁 🙋 🧏 🙇 🤦 🤷 🦸 🦹 💃 🕺 🧘 🛀'.split(' '));
  const withTone = (e, tone) => (tone && TONE_BASE.has(e) ? e.replace('️', '') + TONES[tone] : e);

  // Lists through the dashboard's API proxy, kept for the page.
  const cache = new Map();
  function load(url) {
    if (!cache.has(url)) {
      cache.set(url, fetch(url, { credentials: 'same-origin' }).then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      }).then((d) => d.items || []).catch((err) => { cache.delete(url); throw err; }));
    }
    return cache.get(url);
  }

  const RECENT_KEY = 'bothub.emoji.recent';
  const TONE_KEY = 'bothub.emoji.tone';

  function open(anchor, opts = {}) {
    // The caller's texts, else the page's (a message page knows no picker texts).
    const t = (key) => {
      const v = opts.t?.(key);
      return v && v !== key ? v : defaultT(key);
    };
    const page = pageBot();
    const bot = { id: opts.botId || page.id, name: opts.bot?.name || page.name, avatar: opts.bot?.avatar || page.avatar };
    const base = bot.id ? `/api/v1/bots/${encodeURIComponent(bot.id)}` : '';
    let tone = store.get(TONE_KEY, 0);

    document.querySelector('.bemoji-pop')?.remove();
    const pop = el('div', 'bemoji-pop');
    const close = () => { pop.remove(); document.removeEventListener('pointerdown', outside, true); };
    const outside = (ev) => { if (!pop.contains(ev.target) && !anchor.contains(ev.target)) close(); };
    pop.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } });
    document.addEventListener('pointerdown', outside, true);

    const nav = el('div', 'bemoji-nav');
    const searchRow = el('div', 'bemoji-search');
    const body = el('div', 'bemoji-body');
    const foot = el('div', 'bemoji-foot');

    // A pick: the value goes out and into "Frequently used".
    const pick = (v, custom) => {
      if (v) {
        const recent = store.get(RECENT_KEY, []).filter((r) => r.v !== v);
        recent.unshift(custom ? { v, url: custom.url, name: custom.name } : { v });
        store.set(RECENT_KEY, recent.slice(0, 18));
      }
      opts.onPick?.(v);
      if (!opts.multi || !v) close();
    };
    const emojiBtn = (e, name) => {
      const btn = el('button', 'bemoji-item', e);
      btn.type = 'button';
      btn.title = name || e;
      btn.addEventListener('click', () => pick(e));
      return btn;
    };
    const customBtn = (c) => {
      const btn = el('button', 'bemoji-item');
      btn.type = 'button';
      btn.title = `:${c.name}:`;
      const img = el('img');
      img.src = c.url;
      img.alt = c.name;
      img.loading = 'lazy';
      btn.append(img);
      const value = c.text || c.code || c.v;
      btn.addEventListener('click', () => pick(value, { url: c.url, name: c.name }));
      return btn;
    };
    const status = (key) => el('p', 'bpick-status', t(key));

    // ---- sections: frequently used, the groups, each server, the bot ----
    const sections = []; // {key, head, box, navBtn}
    const navBtn = (key, title, content) => {
      const b = el('button', 'bemoji-nav-btn');
      b.type = 'button';
      b.title = title;
      b.setAttribute('aria-label', title);
      if (content instanceof Node) b.append(content); else b.textContent = content;
      b.addEventListener('click', () => {
        const s = sections.find((x) => x.key === key);
        if (!s) return;
        search.value = '';
        runSearch();
        s.load?.();
        body.scrollTop = s.head.offsetTop - body.offsetTop;
        mark(key);
      });
      nav.append(b);
      return b;
    };
    const imgOrInitial = (url, name, round) => {
      if (url) {
        const img = el('img', round ? 'is-round' : '');
        img.src = url;
        img.alt = '';
        img.loading = 'lazy';
        return img;
      }
      return el('span', 'bemoji-nav-initial', (name || '?').trim().charAt(0).toUpperCase());
    };
    const addSection = (key, title, navContent, fill, lazy) => {
      const head = el('div', 'bemoji-cat', title);
      const box = el('div', 'bemoji-grid');
      body.append(head, box);
      const s = { key, head, box, btn: navBtn(key, title, navContent), loaded: !lazy };
      s.load = () => {
        if (s.loaded) return;
        s.loaded = true;
        fill(box);
      };
      if (!lazy) fill(box);
      sections.push(s);
      return s;
    };
    const fillCustom = (url, empty) => async (box) => {
      box.replaceChildren(status('builder.pick.loading'));
      try {
        const items = await load(url);
        box.replaceChildren(...items.map(customBtn));
        if (!items.length) box.append(status(empty));
        box.dataset.custom = JSON.stringify(items.map((c) => ({ name: c.name, url: c.url, v: c.text || c.code })));
      } catch {
        box.replaceChildren(status('builder.pick.load_failed'));
      }
    };

    const recent = store.get(RECENT_KEY, []);
    if (recent.length) {
      addSection('recent', t('builder.emoji.recent'), '🕘', (box) => {
        for (const r of recent) box.append(r.url ? customBtn(r) : emojiBtn(r.v));
      });
    }
    const groupBoxes = [];
    for (const [key, list] of GROUPS) {
      addSection(key, t(`builder.emoji.cat.${key}`), GROUP_ICON[key], (box) => {
        groupBoxes.push({ box, list });
        for (const x of list) box.append(emojiBtn(withTone(x.e, tone), x.name));
      });
    }
    // After the flags: the servers of the bot (their icons), then the bot itself.
    if (base) {
      load(`${base}/guilds`).then((guilds) => {
        for (const g of guilds.slice(0, 50)) {
          observe(addSection(`guild:${g.id}`, g.name, imgOrInitial(g.iconUrl, g.name, true), fillCustom(`${base}/guilds/${encodeURIComponent(g.id)}/emojis`, 'builder.emoji.none'), true));
        }
        // The bot stays last: its section and button move behind the servers.
        const botSection = sections.find((s) => s.key === 'bot');
        if (botSection) {
          body.append(botSection.head, botSection.box);
          nav.append(botSection.btn);
          sections.push(sections.splice(sections.indexOf(botSection), 1)[0]);
        }
      }).catch(() => { /* no servers: the bot section stays */ });
      addSection('bot', bot.name ? `${bot.name} · ${t('builder.emoji.tab.bot')}` : t('builder.emoji.tab.bot'),
        imgOrInitial(bot.avatar, bot.name || 'B', true), fillCustom(`${base}/app-emojis`, 'builder.emoji.no_bot_emojis'), true);
    }

    // Server and bot emojis load when their section comes into view.
    const io = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) sections.find((s) => s.head === en.target)?.load();
    }, { root: body, rootMargin: '200px' }) : null;
    const observe = (s) => { if (io) io.observe(s.head); else s.load(); };
    sections.filter((s) => !s.loaded).forEach(observe);

    // The header button of the section at the top.
    const mark = (key) => sections.forEach((s) => s.btn.classList.toggle('is-active', s.key === key));
    body.addEventListener('scroll', () => {
      if (body.classList.contains('is-search')) return;
      const top = body.scrollTop + body.offsetTop + 8;
      let current = sections[0]?.key;
      for (const s of sections) if (s.head.offsetTop <= top) current = s.key;
      mark(current);
    });

    // ---- search and skin tone ----
    const searchWrap = el('div', 'bemoji-search-field');
    const search = el('input');
    search.type = 'search';
    search.placeholder = t('builder.emoji.search');
    search.setAttribute('aria-label', t('builder.emoji.search'));
    searchWrap.append(el('span', 'bemoji-search-icon', '🔍'), search);
    const results = el('div', 'bemoji-results');
    function runSearch() {
      const words = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      body.classList.toggle('is-search', words.length > 0);
      results.replaceChildren();
      if (!words.length) return;
      // Searching loads the server and bot emojis not loaded yet.
      sections.forEach((s) => s.load?.());
      const grid = el('div', 'bemoji-grid');
      const match = (name) => words.every((w) => name.toLowerCase().includes(w));
      for (const [, list] of GROUPS) for (const x of list) if (match(x.name)) grid.append(emojiBtn(withTone(x.e, tone), x.name));
      for (const s of sections) {
        if (!s.box.dataset.custom) continue;
        for (const c of JSON.parse(s.box.dataset.custom)) if (match(c.name)) grid.append(customBtn(c));
      }
      results.append(el('div', 'bemoji-cat', t('builder.emoji.results')), grid.childElementCount ? grid : status('builder.emoji.no_results'));
    }
    search.addEventListener('input', runSearch);
    const toneBtn = el('button', 'bemoji-tone');
    toneBtn.type = 'button';
    toneBtn.title = t('builder.emoji.tone');
    toneBtn.setAttribute('aria-label', t('builder.emoji.tone'));
    const showTone = () => { toneBtn.textContent = withTone('✋', tone) || '✋'; };
    showTone();
    toneBtn.addEventListener('click', () => {
      const open = searchRow.querySelector('.bemoji-tones');
      if (open) { open.remove(); return; }
      const row = el('div', 'bemoji-tones');
      TONES.forEach((_, i) => {
        const b = el('button', `bemoji-item${i === tone ? ' is-active' : ''}`, withTone('✋', i));
        b.type = 'button';
        b.addEventListener('click', () => {
          tone = i;
          store.set(TONE_KEY, i);
          showTone();
          row.remove();
          for (const g of groupBoxes) g.box.replaceChildren(...g.list.map((x) => emojiBtn(withTone(x.e, tone), x.name)));
          runSearch();
        });
        row.append(b);
      });
      searchRow.append(row);
    });
    searchRow.append(searchWrap, toneBtn);
    body.prepend(results);

    // ---- footer: None and Done ----
    if (opts.clear !== false) {
      const clear = el('button', 'btn btn-sm', t('builder.emoji.clear'));
      clear.type = 'button';
      clear.addEventListener('click', () => pick(''));
      foot.append(clear);
    }
    const done = el('button', 'btn btn-sm btn-primary bemoji-done', t('builder.emoji.done'));
    done.type = 'button';
    done.addEventListener('click', close);
    foot.append(done);

    pop.append(nav, searchRow, body, foot);
    anchor.append(pop);
    // Near the bottom of the window it opens upwards (room for the full height).
    if (anchor.getBoundingClientRect().bottom + 440 > window.innerHeight && anchor.getBoundingClientRect().top > 440) pop.classList.add('is-up');
    mark(sections[0]?.key);
    search.focus({ preventScroll: true });
    return { close };
  }

  window.BotHubEmojiPicker = { open };
})();
