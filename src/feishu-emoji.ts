/**
 * Valid Feishu emoji type strings for the message-reactions API.
 *
 * Feishu emoji types are case-sensitive and inconsistent: most are uppercase
 * (`THUMBSUP`, `OK`), but a meaningful subset is CamelCase (`Typing`,
 * `CrossMark`, `EatingFood`, `Drumstick`, …). Passing the wrong case fails
 * with HTTP 400 code=231001 "reaction type is invalid" — silent unless the
 * caller is watching logs.
 *
 * Source: openclaw-lark's `VALID_FEISHU_EMOJI_TYPES` (which references the
 * official Feishu emoji doc).
 */
export const VALID_FEISHU_EMOJI_TYPES: ReadonlySet<string> = new Set([
  "OK", "THUMBSUP", "THANKS", "MUSCLE", "FINGERHEART", "APPLAUSE", "FISTBUMP",
  "JIAYI", "DONE", "SMILE", "BLUSH", "LAUGH", "SMIRK", "LOL", "FACEPALM",
  "LOVE", "WINK", "PROUD", "WITTY", "SMART", "SCOWL", "THINKING", "SOB",
  "CRY", "ERROR", "NOSEPICK", "HAUGHTY", "SLAP", "SPITBLOOD", "TOASTED",
  "GLANCE", "DULL", "INNOCENTSMILE", "JOYFUL", "WOW", "TRICK", "YEAH",
  "ENOUGH", "TEARS", "EMBARRASSED", "KISS", "SMOOCH", "DROOL", "OBSESSED",
  "MONEY", "TEASE", "SHOWOFF", "COMFORT", "CLAP", "PRAISE", "STRIVE",
  "XBLUSH", "SILENT", "WAVE", "WHAT", "FROWN", "SHY", "DIZZY", "LOOKDOWN",
  "CHUCKLE", "WAIL", "CRAZY", "WHIMPER", "HUG", "BLUBBER", "WRONGED",
  "HUSKY", "SHHH", "SMUG", "ANGRY", "HAMMER", "SHOCKED", "TERROR",
  "PETRIFIED", "SKULL", "SWEAT", "SPEECHLESS", "SLEEP", "DROWSY", "YAWN",
  "SICK", "PUKE", "BETRAYED", "HEADSET", "EatingFood", "MeMeMe", "Sigh",
  "Typing", "SLIGHT", "TONGUE", "EYESCLOSED", "RoarForYou", "CALF", "BEAR",
  "BULL", "RAINBOWPUKE", "Lemon", "ROSE", "HEART", "PARTY", "LIPS", "BEER",
  "CAKE", "GIFT", "CUCUMBER", "Drumstick", "Pepper", "CANDIEDHAWS",
  "BubbleTea", "Coffee", "Get", "LGTM", "OnIt", "OneSecond", "VRHeadset",
  "YouAreTheBest", "SALUTE", "SHAKE", "HIGHFIVE", "UPPERLEFT", "ThumbsDown",
  "Yes", "No", "OKR", "CheckMark", "CrossMark", "MinusOne", "Hundred",
  "AWESOMEN", "Pin", "Alarm", "Loudspeaker", "Trophy", "Fire", "BOMB",
  "Music", "XmasTree", "Snowman", "XmasHat", "FIREWORKS", "2022",
  "REDPACKET", "FORTUNE", "LUCK", "FIRECRACKER", "StickyRiceBalls",
  "HEARTBROKEN", "POOP", "StatusFlashOfInspiration", "18X", "CLEAVER",
  "Soccer", "Basketball", "GeneralDoNotDisturb", "Status_PrivateMessage",
  "GeneralInMeetingBusy", "StatusReading", "StatusInFlight",
  "GeneralBusinessTrip", "GeneralWorkFromHome", "StatusEnjoyLife",
  "GeneralTravellingCar", "StatusBus", "GeneralSun", "GeneralMoonRest",
  "MoonRabbit", "Mooncake", "JubilantRabbit", "TV", "Movie", "Pumpkin",
  "BeamingFace", "Delighted", "ColdSweat", "FullMoonFace", "Partying",
  "GoGoGo", "ThanksFace", "SaluteFace", "Shrug", "ClownFace", "HappyDragon",
]);

/** Returns true iff `s` is a valid Feishu emoji type string (case-sensitive). */
export function isValidFeishuEmojiType(s: string): boolean {
  return VALID_FEISHU_EMOJI_TYPES.has(s);
}
