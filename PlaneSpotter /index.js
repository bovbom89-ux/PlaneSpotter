
require("dotenv").config();

const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    StringSelectMenuBuilder,
    ChannelSelectMenuBuilder,
    ChannelType,
    PermissionFlagsBits
} = require("discord.js");

const Database = require("better-sqlite3");
const crypto = require("node:crypto");

// =====================================================
// CONFIGURATION
// =====================================================

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID || null;

if (!TOKEN || !CLIENT_ID) {
    console.error("Missing DISCORD_TOKEN or DISCORD_CLIENT_ID.");
    process.exit(1);
}

const COLOUR = 0xF73C4B;
const DATABASE_FILE = "./planespotter.sqlite";

const COMMONS_API = "https://commons.wikimedia.org/w/api.php";

const DEFAULT_INTERVAL = 30;
const DEFAULT_DURATION = 10;
const MAX_TIMER = 2147483647;
const IMAGE_TIMEOUT = 12000;
const RETRY_DELAY = 60000;

const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

const db = new Database(DATABASE_FILE);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

// =====================================================
// DATABASE
// =====================================================

db.exec(`
CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id TEXT PRIMARY KEY,
    channel_id TEXT,
    interval_minutes INTEGER DEFAULT 30,
    answer_minutes INTEGER DEFAULT 10,
    difficulty TEXT DEFAULT 'mixed',
    auto_reveal INTEGER DEFAULT 1,
    enabled INTEGER DEFAULT 0,
    last_post_at INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS games (
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT,
    aircraft_id TEXT NOT NULL,
    aircraft_name TEXT NOT NULL,
    aliases_json TEXT NOT NULL,
    image_url TEXT,
    posted_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    status TEXT DEFAULT 'active'
);

CREATE INDEX IF NOT EXISTS idx_games_guild
ON games(guild_id, posted_at);

CREATE INDEX IF NOT EXISTS idx_games_status
ON games(guild_id, status);

CREATE TABLE IF NOT EXISTS attempts (
    game_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    answer TEXT NOT NULL,
    correct INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(game_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_attempts_user
ON attempts(user_id);

CREATE INDEX IF NOT EXISTS idx_attempts_guild_user
ON attempts(guild_id, user_id);

CREATE TABLE IF NOT EXISTS score_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    points INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scores_guild
ON score_events(guild_id, created_at);

CREATE INDEX IF NOT EXISTS idx_scores_user
ON score_events(user_id, created_at);

CREATE TABLE IF NOT EXISTS aircraft_usage (
    guild_id TEXT NOT NULL,
    aircraft_id TEXT NOT NULL,
    used_at INTEGER NOT NULL,
    PRIMARY KEY(guild_id, aircraft_id)
);

CREATE INDEX IF NOT EXISTS idx_aircraft_usage_guild
ON aircraft_usage(guild_id);

CREATE TABLE IF NOT EXISTS player_streaks (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    current_streak INTEGER DEFAULT 0,
    longest_streak INTEGER DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS user_achievements (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    achievement_id TEXT NOT NULL,
    unlocked_at INTEGER NOT NULL,
    PRIMARY KEY(guild_id, user_id, achievement_id)
);
`);

// Existing games are included in the rotation history.
// This prevents old aircraft from immediately repeating.

db.exec(`
INSERT OR IGNORE INTO aircraft_usage (
    guild_id,
    aircraft_id,
    used_at
)
SELECT
    guild_id,
    aircraft_id,
    MAX(posted_at)
FROM games
GROUP BY guild_id, aircraft_id;
`);

const statements = {
    getSettings: db.prepare(`
        SELECT * FROM guild_settings WHERE guild_id = ?
    `),

    insertSettings: db.prepare(`
        INSERT OR IGNORE INTO guild_settings (guild_id)
        VALUES (?)
    `),

    updateSetting: db.prepare(`
        UPDATE guild_settings
        SET channel_id = ?,
            interval_minutes = ?,
            answer_minutes = ?,
            difficulty = ?,
            auto_reveal = ?,
            enabled = ?
        WHERE guild_id = ?
    `),

    updateLastPost: db.prepare(`
        UPDATE guild_settings
        SET last_post_at = ?
        WHERE guild_id = ?
    `),

    activeGames: db.prepare(`
        SELECT * FROM games
        WHERE guild_id = ? AND status = 'active'
    `),

    getGame: db.prepare(`
        SELECT * FROM games WHERE id = ?
    `),

    insertGame: db.prepare(`
        INSERT INTO games (
            id, guild_id, channel_id, message_id,
            aircraft_id, aircraft_name, aliases_json,
            image_url, posted_at, expires_at, status
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
    `),

    closeGame: db.prepare(`
        UPDATE games
        SET status = ?
        WHERE id = ? AND status = 'active'
    `),

    insertAttempt: db.prepare(`
        INSERT INTO attempts (
            game_id, guild_id, user_id,
            answer, correct, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
    `),

    addScore: db.prepare(`
        INSERT INTO score_events (
            guild_id, user_id, points, created_at
        )
        VALUES (?, ?, 1, ?)
    `),

    getStreak: db.prepare(`
        SELECT * FROM player_streaks
        WHERE guild_id = ? AND user_id = ?
    `),

    saveStreak: db.prepare(`
        INSERT INTO player_streaks (
            guild_id, user_id, current_streak,
            longest_streak, updated_at
        )
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(guild_id, user_id)
        DO UPDATE SET
            current_streak = excluded.current_streak,
            longest_streak = MAX(
                player_streaks.longest_streak,
                excluded.longest_streak
            ),
            updated_at = excluded.updated_at
    `),

    addAchievement: db.prepare(`
        INSERT OR IGNORE INTO user_achievements (
            guild_id, user_id, achievement_id, unlocked_at
        )
        VALUES (?, ?, ?, ?)
    `)
};

function getSettings(guildId) {
    statements.insertSettings.run(guildId);
    return statements.getSettings.get(guildId);
}

function updateSettings(guildId, settings) {
    statements.updateSetting.run(
        settings.channel_id,
        settings.interval_minutes,
        settings.answer_minutes,
        settings.difficulty,
        settings.auto_reveal,
        settings.enabled,
        guildId
    );
}

// =====================================================
// AIRCRAFT DATABASE
// =====================================================

// Each aircraft has an individual ID.
// Individual variants are separate entries.
//
// Aliases must identify the specific variant.
// Avoid adding broad family names to individual variants.

const AIRCRAFT = [];

function addAircraft(
    id,
    name,
    aliases,
    category,
    difficulty,
    wiki
) {
    AIRCRAFT.push({
        id,
        name,
        aliases: aliases || [],
        category,
        difficulty,
        wiki
    });
}

function addVariants(
    manufacturer,
    family,
    variants,
    category,
    difficulty,
    wiki
) {
    for (const variant of variants) {
        const name = `${manufacturer} ${family}-${variant}`;
        const id = `${manufacturer}-${family}-${variant}`
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-");

        const shortFamily = family.replace(/[^a-z0-9]/gi, "");

        addAircraft(
            id,
            name,
            [
                `${family}-${variant}`,
                `${family} ${variant}`,
                `${shortFamily}-${variant}`
            ],
            category,
            difficulty,
            wiki
        );
    }
}

// -----------------------------------------------------
// AIRBUS
// -----------------------------------------------------

addAircraft("airbus-a300", "Airbus A300", ["A300", "A300B"], "Commercial", "medium", "Airbus A300");
addAircraft("airbus-a310", "Airbus A310", ["A310"], "Commercial", "medium", "Airbus A310");

addAircraft("airbus-a318", "Airbus A318", ["A318"], "Commercial", "hard", "Airbus A318");
addAircraft("airbus-a319", "Airbus A319", ["A319"], "Commercial", "easy", "Airbus A319");
addAircraft("airbus-a320", "Airbus A320", ["A320", "A320-200"], "Commercial", "easy", "Airbus A320");
addAircraft("airbus-a321", "Airbus A321", ["A321", "A321-200"], "Commercial", "easy", "Airbus A321");

addAircraft("airbus-a320neo", "Airbus A320neo", ["A320neo", "A320 NEO"], "Commercial", "medium", "Airbus A320neo");
addAircraft("airbus-a321neo", "Airbus A321neo", ["A321neo", "A321 NEO"], "Commercial", "medium", "Airbus A321neo");
addAircraft("airbus-a321xlr", "Airbus A321XLR", ["A321 XLR", "A321XLR"], "Commercial", "hard", "Airbus A321neo");

addAircraft("airbus-a330-200", "Airbus A330-200", ["A330-200", "A332"], "Commercial", "medium", "Airbus A330");
addAircraft("airbus-a330-300", "Airbus A330-300", ["A330-300", "A333"], "Commercial", "medium", "Airbus A330");
addAircraft("airbus-a330-800", "Airbus A330-800neo", ["A330-800", "A338"], "Commercial", "expert", "Airbus A330neo");
addAircraft("airbus-a330-900", "Airbus A330-900neo", ["A330-900", "A339"], "Commercial", "hard", "Airbus A330neo");

addAircraft("airbus-a340-200", "Airbus A340-200", ["A340-200"], "Commercial", "hard", "Airbus A340");
addAircraft("airbus-a340-300", "Airbus A340-300", ["A340-300"], "Commercial", "medium", "Airbus A340");
addAircraft("airbus-a340-500", "Airbus A340-500", ["A340-500"], "Commercial", "hard", "Airbus A340");
addAircraft("airbus-a340-600", "Airbus A340-600", ["A340-600"], "Commercial", "medium", "Airbus A340");

addAircraft("airbus-a350-900", "Airbus A350-900", ["A350-900", "A359"], "Commercial", "easy", "Airbus A350");
addAircraft("airbus-a350-1000", "Airbus A350-1000", ["A350-1000", "A35K"], "Commercial", "medium", "Airbus A350");

addAircraft("airbus-a380", "Airbus A380-800", ["A380", "A380-800", "Superjumbo"], "Commercial", "easy", "Airbus A380");

// -----------------------------------------------------
// BOEING
// -----------------------------------------------------

addAircraft("boeing-707", "Boeing 707", ["707", "B707"], "Historic", "medium", "Boeing 707");
addAircraft("boeing-717", "Boeing 717", ["717", "MD-95", "MD95"], "Commercial", "hard", "Boeing 717");
addAircraft("boeing-727-100", "Boeing 727-100", ["727-100"], "Historic", "expert", "Boeing 727");
addAircraft("boeing-727-200", "Boeing 727-200", ["727-200"], "Historic", "hard", "Boeing 727");

for (const variant of [
    "200", "300", "400", "500",
    "600", "700", "800", "900", "900ER"
]) {
    addAircraft(
        `boeing-737-${variant}`,
        `Boeing 737-${variant}`,
        [`737-${variant}`, `737 ${variant}`],
        "Commercial",
        ["200", "300", "400", "500"].includes(variant) ? "hard" : "medium",
        "Boeing 737"
    );
}

for (const variant of ["7", "8", "9", "10"]) {
    addAircraft(
        `boeing-737-max-${variant}`,
        `Boeing 737 MAX ${variant}`,
        [`737 MAX ${variant}`, `737MAX${variant}`, `MAX ${variant}`],
        "Commercial",
        "hard",
        "Boeing 737 MAX"
    );
}

for (const variant of [
    "100", "200", "300", "400",
    "400ER", "8"
]) {
    addAircraft(
        `boeing-747-${variant.toLowerCase()}`,
        `Boeing 747-${variant}`,
        [`747-${variant}`, `747 ${variant}`],
        variant === "100" || variant === "200" || variant === "300"
            ? "Historic"
            : "Commercial",
        "medium",
        "Boeing 747"
    );
}

addAircraft("boeing-747sp", "Boeing 747SP", ["747SP", "747 SP"], "Historic", "expert", "Boeing 747SP");

addAircraft("boeing-757-200", "Boeing 757-200", ["757-200"], "Commercial", "medium", "Boeing 757");
addAircraft("boeing-757-300", "Boeing 757-300", ["757-300"], "Commercial", "hard", "Boeing 757");

addAircraft("boeing-767-200", "Boeing 767-200", ["767-200"], "Commercial", "hard", "Boeing 767");
addAircraft("boeing-767-300", "Boeing 767-300", ["767-300"], "Commercial", "medium", "Boeing 767");
addAircraft("boeing-767-400", "Boeing 767-400ER", ["767-400ER", "767-400"], "Commercial", "hard", "Boeing 767");

addAircraft("boeing-777-200", "Boeing 777-200", ["777-200"], "Commercial", "medium", "Boeing 777");
addAircraft("boeing-777-200er", "Boeing 777-200ER", ["777-200ER"], "Commercial", "medium", "Boeing 777");
addAircraft("boeing-777-200lr", "Boeing 777-200LR", ["777-200LR"], "Commercial", "hard", "Boeing 777");
addAircraft("boeing-777-300", "Boeing 777-300", ["777-300"], "Commercial", "medium", "Boeing 777");
addAircraft("boeing-777-300er", "Boeing 777-300ER", ["777-300ER"], "Commercial", "easy", "Boeing 777");
addAircraft("boeing-777-9", "Boeing 777-9", ["777X", "777-9"], "Commercial", "hard", "Boeing 777X");

addAircraft("boeing-787-8", "Boeing 787-8 Dreamliner", ["787-8", "B788"], "Commercial", "medium", "Boeing 787 Dreamliner");
addAircraft("boeing-787-9", "Boeing 787-9 Dreamliner", ["787-9", "B789"], "Commercial", "easy", "Boeing 787 Dreamliner");
addAircraft("boeing-787-10", "Boeing 787-10 Dreamliner", ["787-10", "B78X"], "Commercial", "medium", "Boeing 787 Dreamliner");

// -----------------------------------------------------
// DOUGLAS / MCDONNELL DOUGLAS
// -----------------------------------------------------

addAircraft("dc3", "Douglas DC-3", ["DC-3", "DC3", "Dakota"], "Historic", "medium", "Douglas DC-3");
addAircraft("dc4", "Douglas DC-4", ["DC-4", "DC4"], "Historic", "hard", "Douglas DC-4");
addAircraft("dc6", "Douglas DC-6", ["DC-6", "DC6"], "Historic", "hard", "Douglas DC-6");
addAircraft("dc7", "Douglas DC-7", ["DC-7", "DC7"], "Historic", "expert", "Douglas DC-7");
addAircraft("dc8", "Douglas DC-8", ["DC-8", "DC8"], "Historic", "hard", "Douglas DC-8");
addAircraft("dc9", "Douglas DC-9", ["DC-9", "DC9"], "Historic", "hard", "Douglas DC-9");
addAircraft("dc10", "McDonnell Douglas DC-10", ["DC-10", "DC10"], "Historic", "medium", "McDonnell Douglas DC-10");
addAircraft("md11", "McDonnell Douglas MD-11", ["MD-11", "MD11"], "Commercial", "hard", "McDonnell Douglas MD-11");
addAircraft("md80", "McDonnell Douglas MD-80", ["MD-80", "MD80"], "Historic", "hard", "McDonnell Douglas MD-80");
addAircraft("md90", "McDonnell Douglas MD-90", ["MD-90", "MD90"], "Commercial", "expert", "McDonnell Douglas MD-90");

// -----------------------------------------------------
// BRITISH AND EUROPEAN AIRCRAFT
// -----------------------------------------------------

addAircraft("concorde", "Concorde", ["BAC Concorde", "Aérospatiale-BAC Concorde"], "Historic", "easy", "Concorde");
addAircraft("comet", "de Havilland Comet", ["DH.106 Comet", "Comet"], "Historic", "hard", "De Havilland Comet");
addAircraft("dh121", "Hawker Siddeley Trident", ["HS Trident", "Trident"], "Historic", "expert", "Hawker Siddeley Trident");
addAircraft("vc10", "Vickers VC10", ["VC10", "Vickers 10"], "Historic", "hard", "Vickers VC10");
addAircraft("viscount", "Vickers Viscount", ["Viscount"], "Historic", "hard", "Vickers Viscount");
addAircraft("bac111", "BAC One-Eleven", ["BAC 1-11", "BAC111"], "Historic", "expert", "BAC One-Eleven");
addAircraft("bae146", "British Aerospace 146", ["BAe 146", "BAE146", "Whisperjet"], "Regional", "hard", "British Aerospace 146");
addAircraft("avro-rj70", "Avro RJ70", ["RJ70"], "Regional", "expert", "Avro RJ70");
addAircraft("avro-rj85", "Avro RJ85", ["RJ85"], "Regional", "hard", "Avro RJ85");
addAircraft("avro-rj100", "Avro RJ100", ["RJ100"], "Regional", "hard", "Avro RJ100");

addAircraft("fokker27", "Fokker F27 Friendship", ["F27", "Fokker Friendship"], "Historic", "hard", "Fokker F27 Friendship");
addAircraft("fokker50", "Fokker 50", ["F50"], "Regional", "hard", "Fokker 50");
addAircraft("fokker70", "Fokker 70", ["F70"], "Regional", "hard", "Fokker 70");
addAircraft("fokker100", "Fokker 100", ["F100", "Fokker F100"], "Regional", "hard", "Fokker 100");

addAircraft("atr42", "ATR 42", ["ATR42", "ATR-42"], "Regional", "medium", "ATR 42");
addAircraft("atr72", "ATR 72", ["ATR72", "ATR-72"], "Regional", "easy", "ATR 72");

addAircraft("dash8-100", "De Havilland Canada Dash 8-100", ["DHC-8-100", "Dash 8-100"], "Regional", "expert", "De Havilland Canada Dash 8");
addAircraft("dash8-300", "De Havilland Canada Dash 8-300", ["DHC-8-300", "Dash 8-300"], "Regional", "hard", "De Havilland Canada Dash 8");
addAircraft("dash8-q400", "De Havilland Canada Dash 8 Q400", ["Q400", "DHC-8-400", "Dash 8 Q400"], "Regional", "medium", "De Havilland Canada Dash 8");

addAircraft("saab340", "Saab 340", ["SF340", "SAAB 340"], "Regional", "hard", "Saab 340");
addAircraft("saab2000", "Saab 2000", ["SF2000"], "Regional", "expert", "Saab 2000");

// -----------------------------------------------------
// EMBRAER AND BOMBARDIER
// -----------------------------------------------------

for (const variant of ["E170", "E175", "E190", "E195"]) {
    addAircraft(
        `embraer-${variant.toLowerCase()}`,
        `Embraer ${variant}`,
        [variant, `ERJ-${variant.slice(1)}`],
        "Regional",
        variant === "E170" ? "hard" : "medium",
        "Embraer E-Jet family"
    );
}

for (const variant of ["E175-E2", "E190-E2", "E195-E2"]) {
    addAircraft(
        `embraer-${variant.toLowerCase()}`,
        `Embraer ${variant}`,
        [variant.replace("-", " "), variant.replaceAll("-", "")],
        "Regional",
        "hard",
        "Embraer E-Jet E2 family"
    );
}

addAircraft("embraer-erj135", "Embraer ERJ-135", ["ERJ135", "ERJ 135"], "Regional", "hard", "Embraer ERJ family");
addAircraft("embraer-erj140", "Embraer ERJ-140", ["ERJ140", "ERJ 140"], "Regional", "expert", "Embraer ERJ family");
addAircraft("embraer-erj145", "Embraer ERJ-145", ["ERJ145", "ERJ 145"], "Regional", "medium", "Embraer ERJ family");

addAircraft("crj100", "Bombardier CRJ100", ["CRJ-100", "CRJ 100"], "Regional", "expert", "Bombardier CRJ100");
addAircraft("crj200", "Bombardier CRJ200", ["CRJ-200", "CRJ 200"], "Regional", "hard", "Bombardier CRJ200");
addAircraft("crj700", "Bombardier CRJ700", ["CRJ-700", "CRJ 700"], "Regional", "hard", "Bombardier CRJ700");
addAircraft("crj900", "Bombardier CRJ900", ["CRJ-900", "CRJ 900"], "Regional", "medium", "Bombardier CRJ900");
addAircraft("crj1000", "Bombardier CRJ1000", ["CRJ-1000", "CRJ 1000"], "Regional", "hard", "Bombardier CRJ1000");

addAircraft("bombardier-cseries", "Bombardier CSeries", ["CSeries"], "Commercial", "hard", "Airbus A220");
addAircraft("airbus-a220-100", "Airbus A220-100", ["A220-100", "BD-500-1A10"], "Commercial", "medium", "Airbus A220");
addAircraft("airbus-a220-300", "Airbus A220-300", ["A220-300", "BD-500-1A11"], "Commercial", "medium", "Airbus A220");

// -----------------------------------------------------
// MILITARY AIRCRAFT
// -----------------------------------------------------

addAircraft("sr71", "Lockheed SR-71 Blackbird", ["SR-71", "SR71", "Blackbird"], "Military", "medium", "Lockheed SR-71 Blackbird");
addAircraft("u2", "Lockheed U-2", ["U-2", "U2", "Dragon Lady"], "Military", "hard", "Lockheed U-2");
addAircraft("f14", "Grumman F-14 Tomcat", ["F-14", "F14", "Tomcat"], "Military", "medium", "Grumman F-14 Tomcat");
addAircraft("f15", "McDonnell Douglas F-15 Eagle", ["F-15", "F15", "Eagle"], "Military", "medium", "McDonnell Douglas F-15 Eagle");
addAircraft("f16", "General Dynamics F-16 Fighting Falcon", ["F-16", "F16", "Fighting Falcon"], "Military", "easy", "General Dynamics F-16 Fighting Falcon");
addAircraft("f18", "McDonnell Douglas F/A-18 Hornet", ["F/A-18", "FA18", "F18", "Hornet"], "Military", "medium", "McDonnell Douglas F/A-18 Hornet");
addAircraft("f18e", "Boeing F/A-18E Super Hornet", ["F/A-18E", "F18E", "Super Hornet"], "Military", "hard", "Boeing F/A-18E/F Super Hornet");
addAircraft("f22", "Lockheed Martin F-22 Raptor", ["F-22", "F22", "Raptor"], "Military", "easy", "Lockheed Martin F-22 Raptor");
addAircraft("f35a", "Lockheed Martin F-35A Lightning II", ["F-35A", "F35A"], "Military", "medium", "Lockheed Martin F-35 Lightning II");
addAircraft("f35b", "Lockheed Martin F-35B Lightning II", ["F-35B", "F35B"], "Military", "hard", "Lockheed Martin F-35 Lightning II");
addAircraft("f35c", "Lockheed Martin F-35C Lightning II", ["F-35C", "F35C"], "Military", "hard", "Lockheed Martin F-35 Lightning II");

addAircraft("f4", "McDonnell Douglas F-4 Phantom II", ["F-4", "F4", "Phantom II"], "Military", "medium", "McDonnell Douglas F-4 Phantom II");
addAircraft("f5", "Northrop F-5 Tiger II", ["F-5", "F5", "Tiger II"], "Military", "hard", "Northrop F-5");
addAircraft("f104", "Lockheed F-104 Starfighter", ["F-104", "F104", "Starfighter"], "Military", "hard", "Lockheed F-104 Starfighter");
addAircraft("f111", "General Dynamics F-111 Aardvark", ["F-111", "F111", "Aardvark"], "Military", "hard", "General Dynamics F-111 Aardvark");
addAircraft("a10", "Fairchild Republic A-10 Thunderbolt II", ["A-10", "A10", "Warthog"], "Military", "easy", "Fairchild Republic A-10 Thunderbolt II");
addAircraft("b52", "Boeing B-52 Stratofortress", ["B-52", "B52", "Stratofortress"], "Military", "medium", "Boeing B-52 Stratofortress");
addAircraft("b1", "Rockwell B-1B Lancer", ["B-1B", "B1B", "Lancer"], "Military", "hard", "Rockwell B-1 Lancer");
addAircraft("b2", "Northrop Grumman B-2 Spirit", ["B-2", "B2", "Spirit"], "Military", "easy", "Northrop Grumman B-2 Spirit");
addAircraft("c130", "Lockheed C-130 Hercules", ["C-130", "C130", "Hercules"], "Military", "easy", "Lockheed C-130 Hercules");
addAircraft("c130j", "Lockheed Martin C-130J Super Hercules", ["C-130J", "C130J", "Super Hercules"], "Military", "medium", "Lockheed Martin C-130J Super Hercules");
addAircraft("c17", "Boeing C-17 Globemaster III", ["C-17", "C17", "Globemaster"], "Military", "medium", "Boeing C-17 Globemaster III");
addAircraft("c5", "Lockheed C-5 Galaxy", ["C-5", "C5", "Galaxy"], "Military", "medium", "Lockheed C-5 Galaxy");
addAircraft("kc135", "Boeing KC-135 Stratotanker", ["KC-135", "KC135", "Stratotanker"], "Military", "hard", "Boeing KC-135 Stratotanker");
addAircraft("e3", "Boeing E-3 Sentry", ["E-3", "E3", "AWACS"], "Military", "medium", "Boeing E-3 Sentry");
addAircraft("p3", "Lockheed P-3 Orion", ["P-3", "P3", "Orion"], "Military", "hard", "Lockheed P-3 Orion");
addAircraft("p8", "Boeing P-8 Poseidon", ["P-8", "P8", "Poseidon"], "Military", "medium", "Boeing P-8 Poseidon");
addAircraft("v22", "Bell Boeing V-22 Osprey", ["V-22", "V22", "Osprey"], "Military", "medium", "Bell Boeing V-22 Osprey");
addAircraft("a400m", "Airbus A400M Atlas", ["A400M", "A400 M", "Atlas"], "Military", "medium", "Airbus A400M Atlas");
addAircraft("rafale", "Dassault Rafale", ["Rafale"], "Military", "easy", "Dassault Rafale");
addAircraft("eurofighter", "Eurofighter Typhoon", ["Typhoon", "Eurofighter"], "Military", "easy", "Eurofighter Typhoon");
addAircraft("tornado", "Panavia Tornado", ["Tornado"], "Military", "medium", "Panavia Tornado");
addAircraft("gripen", "Saab JAS 39 Gripen", ["JAS 39", "Gripen"], "Military", "medium", "Saab JAS 39 Gripen");
addAircraft("mirage2000", "Dassault Mirage 2000", ["Mirage 2000", "Mirage2000"], "Military", "medium", "Dassault Mirage 2000");
addAircraft("mirage3", "Dassault Mirage III", ["Mirage III", "Mirage 3"], "Military", "hard", "Dassault Mirage III");
addAircraft("mig21", "Mikoyan-Gurevich MiG-21", ["MiG-21", "Mig21"], "Military", "medium", "Mikoyan-Gurevich MiG-21");
addAircraft("mig29", "Mikoyan MiG-29", ["MiG-29", "Mig29", "Fulcrum"], "Military", "medium", "Mikoyan MiG-29");
addAircraft("mig31", "Mikoyan MiG-31", ["MiG-31", "Mig31", "Foxhound"], "Military", "hard", "Mikoyan MiG-31");
addAircraft("su27", "Sukhoi Su-27", ["Su-27", "SU27", "Flanker"], "Military", "medium", "Sukhoi Su-27");
addAircraft("su30", "Sukhoi Su-30", ["Su-30", "SU30"], "Military", "hard", "Sukhoi Su-30");
addAircraft("su34", "Sukhoi Su-34", ["Su-34", "SU34", "Fullback"], "Military", "hard", "Sukhoi Su-34");
addAircraft("su35", "Sukhoi Su-35", ["Su-35", "SU35"], "Military", "hard", "Sukhoi Su-35");
addAircraft("su57", "Sukhoi Su-57", ["Su-57", "SU57"], "Military", "medium", "Sukhoi Su-57");

// -----------------------------------------------------
// HISTORIC AIRCRAFT
// -----------------------------------------------------

addAircraft("spitfire", "Supermarine Spitfire", ["Spitfire"], "Historic", "easy", "Supermarine Spitfire");
addAircraft("hurricane", "Hawker Hurricane", ["Hurricane"], "Historic", "medium", "Hawker Hurricane");
addAircraft("mustang", "North American P-51 Mustang", ["P-51", "P51", "Mustang"], "Historic", "medium", "North American P-51 Mustang");
addAircraft("b17", "Boeing B-17 Flying Fortress", ["B-17", "B17", "Flying Fortress"], "Historic", "medium", "Boeing B-17 Flying Fortress");
addAircraft("b24", "Consolidated B-24 Liberator", ["B-24", "B24", "Liberator"], "Historic", "hard", "Consolidated B-24 Liberator");
addAircraft("b25", "North American B-25 Mitchell", ["B-25", "B25", "Mitchell"], "Historic", "hard", "North American B-25 Mitchell");
addAircraft("b29", "Boeing B-29 Superfortress", ["B-29", "B29", "Superfortress"], "Historic", "medium", "Boeing B-29 Superfortress");
addAircraft("lancaster", "Avro Lancaster", ["Lancaster"], "Historic", "easy", "Avro Lancaster");
addAircraft("mosquito", "de Havilland Mosquito", ["Mosquito"], "Historic", "medium", "De Havilland Mosquito");
addAircraft("vulcan", "Avro Vulcan", ["Vulcan"], "Historic", "medium", "Avro Vulcan");
addAircraft("valiant", "Vickers Valiant", ["Valiant"], "Historic", "expert", "Vickers Valiant");
addAircraft("victor", "Handley Page Victor", ["Victor"], "Historic", "hard", "Handley Page Victor");
addAircraft("f86", "North American F-86 Sabre", ["F-86", "F86", "Sabre"], "Historic", "medium", "North American F-86 Sabre");
addAircraft("f4u", "Vought F4U Corsair", ["F4U", "Corsair"], "Historic", "medium", "Vought F4U Corsair");
addAircraft("p38", "Lockheed P-38 Lightning", ["P-38", "P38", "Lightning"], "Historic", "medium", "Lockheed P-38 Lightning");
addAircraft("p40", "Curtiss P-40 Warhawk", ["P-40", "P40", "Warhawk"], "Historic", "hard", "Curtiss P-40 Warhawk");
addAircraft("zero", "Mitsubishi A6M Zero", ["A6M Zero", "Zero"], "Historic", "medium", "Mitsubishi A6M Zero");
addAircraft("me109", "Messerschmitt Bf 109", ["Bf 109", "Me 109", "BF109"], "Historic", "medium", "Messerschmitt Bf 109");
addAircraft("fw190", "Focke-Wulf Fw 190", ["Fw 190", "FW190"], "Historic", "hard", "Focke-Wulf Fw 190");
addAircraft("ju87", "Junkers Ju 87 Stuka", ["Ju 87", "JU87", "Stuka"], "Historic", "hard", "Junkers Ju 87");
addAircraft("he111", "Heinkel He 111", ["He 111", "HE111"], "Historic", "hard", "Heinkel He 111");
addAircraft("arado234", "Arado Ar 234", ["Ar 234", "AR234"], "Historic", "expert", "Arado Ar 234");

// -----------------------------------------------------
// GENERAL AVIATION
// -----------------------------------------------------

addAircraft("cessna150", "Cessna 150", ["C150"], "General Aviation", "medium", "Cessna 150");
addAircraft("cessna152", "Cessna 152", ["C152"], "General Aviation", "medium", "Cessna 152");
addAircraft("cessna172", "Cessna 172 Skyhawk", ["C172", "Skyhawk"], "General Aviation", "easy", "Cessna 172");
addAircraft("cessna182", "Cessna 182 Skylane", ["C182", "Skylane"], "General Aviation", "medium", "Cessna 182");
addAircraft("cessna206", "Cessna 206 Stationair", ["C206", "Stationair"], "General Aviation", "hard", "Cessna 206");
addAircraft("cessna208", "Cessna 208 Caravan", ["C208", "Caravan"], "General Aviation", "medium", "Cessna 208 Caravan");
addAircraft("cessna210", "Cessna 210 Centurion", ["C210", "Centurion"], "General Aviation", "hard", "Cessna 210");
addAircraft("cessna310", "Cessna 310", ["C310"], "General Aviation", "hard", "Cessna 310");
addAircraft("cessna402", "Cessna 402", ["C402"], "General Aviation", "expert", "Cessna 402");
addAircraft("cessna414", "Cessna 414", ["C414"], "General Aviation", "expert", "Cessna 414");
addAircraft("cessna citation x", "Cessna Citation X", ["Citation X"], "Business Jet", "hard", "Cessna Citation X");

addAircraft("piper-pa28", "Piper PA-28 Cherokee", ["PA-28", "Cherokee"], "General Aviation", "medium", "Piper PA-28 Cherokee");
addAircraft("piper-pa32", "Piper PA-32 Saratoga", ["PA-32", "Saratoga"], "General Aviation", "hard", "Piper PA-32");
addAircraft("piper-pa34", "Piper PA-34 Seneca", ["PA-34", "Seneca"], "General Aviation", "hard", "Piper PA-34 Seneca");
addAircraft("piper-pa46", "Piper PA-46 Malibu", ["PA-46", "Malibu"], "General Aviation", "hard", "Piper PA-46");
addAircraft("piper-m600", "Piper M600", ["M600"], "General Aviation", "expert", "Piper M600");

addAircraft("beechcraft-bonanza", "Beechcraft Bonanza", ["Bonanza"], "General Aviation", "medium", "Beechcraft Bonanza");
addAircraft("beechcraft-baron", "Beechcraft Baron", ["Baron"], "General Aviation", "medium", "Beechcraft Baron");
addAircraft("beechcraft-kingair", "Beechcraft King Air", ["King Air"], "General Aviation", "easy", "Beechcraft King Air");
addAircraft("beechcraft-1900", "Beechcraft 1900", ["B1900", "Beech 1900"], "Regional", "hard", "Beechcraft 1900");

addAircraft("pilatus-pc12", "Pilatus PC-12", ["PC-12", "PC12"], "General Aviation", "medium", "Pilatus PC-12");
addAircraft("pilatus-pc24", "Pilatus PC-24", ["PC-24", "PC24"], "Business Jet", "hard", "Pilatus PC-24");
addAircraft("diamond-da40", "Diamond DA40", ["DA40"], "General Aviation", "medium", "Diamond DA40");
addAircraft("diamond-da42", "Diamond DA42", ["DA42"], "General Aviation", "hard", "Diamond DA42");
addAircraft("cirrus-sr20", "Cirrus SR20", ["SR20"], "General Aviation", "medium", "Cirrus SR20");
addAircraft("cirrus-sr22", "Cirrus SR22", ["SR22"], "General Aviation", "medium", "Cirrus SR22");

// -----------------------------------------------------
// BUSINESS JETS
// -----------------------------------------------------

addAircraft("gulfstream-g280", "Gulfstream G280", ["G280"], "Business Jet", "hard", "Gulfstream G280");
addAircraft("gulfstream-g450", "Gulfstream G450", ["G450"], "Business Jet", "hard", "Gulfstream G450");
addAircraft("gulfstream-g500", "Gulfstream G500", ["G500"], "Business Jet", "medium", "Gulfstream G500");
addAircraft("gulfstream-g550", "Gulfstream G550", ["G550"], "Business Jet", "medium", "Gulfstream G550");
addAircraft("gulfstream-g600", "Gulfstream G600", ["G600"], "Business Jet", "medium", "Gulfstream G600");
addAircraft("gulfstream-g650", "Gulfstream G650", ["G650"], "Business Jet", "medium", "Gulfstream G650");
addAircraft("gulfstream-g700", "Gulfstream G700", ["G700"], "Business Jet", "hard", "Gulfstream G700");
addAircraft("gulfstream-g800", "Gulfstream G800", ["G800"], "Business Jet", "expert", "Gulfstream G800");

addAircraft("challenger-300", "Bombardier Challenger 300", ["Challenger 300"], "Business Jet", "hard", "Bombardier Challenger 300");
addAircraft("challenger-350", "Bombardier Challenger 350", ["Challenger 350"], "Business Jet", "hard", "Bombardier Challenger 350");
addAircraft("challenger-600", "Bombardier Challenger 600", ["Challenger 600"], "Business Jet", "hard", "Bombardier Challenger 600");
addAircraft("challenger-650", "Bombardier Challenger 650", ["Challenger 650"], "Business Jet", "hard", "Bombardier Challenger 600");
addAircraft("global-5000", "Bombardier Global 5000", ["Global 5000"], "Business Jet", "hard", "Bombardier Global Express");
addAircraft("global-6000", "Bombardier Global 6000", ["Global 6000"], "Business Jet", "medium", "Bombardier Global Express");
addAircraft("global-7500", "Bombardier Global 7500", ["Global 7500"], "Business Jet", "medium", "Bombardier Global 7500");

addAircraft("falcon-2000", "Dassault Falcon 2000", ["Falcon 2000"], "Business Jet", "hard", "Dassault Falcon 2000");
addAircraft("falcon-7x", "Dassault Falcon 7X", ["Falcon 7X", "F7X"], "Business Jet", "hard", "Dassault Falcon 7X");
addAircraft("falcon-8x", "Dassault Falcon 8X", ["Falcon 8X", "F8X"], "Business Jet", "hard", "Dassault Falcon 8X");
addAircraft("falcon-900", "Dassault Falcon 900", ["Falcon 900"], "Business Jet", "hard", "Dassault Falcon 900");
addAircraft("learjet-45", "Learjet 45", ["LJ45"], "Business Jet", "hard", "Learjet 45");
addAircraft("learjet-60", "Learjet 60", ["LJ60"], "Business Jet", "hard", "Learjet 60");
addAircraft("citation-mustang", "Cessna Citation Mustang", ["Citation Mustang"], "Business Jet", "medium", "Cessna Citation Mustang");
addAircraft("citation-sovereign", "Cessna Citation Sovereign", ["Citation Sovereign"], "Business Jet", "hard", "Cessna Citation Sovereign");
addAircraft("citation-longitude", "Cessna Citation Longitude", ["Citation Longitude"], "Business Jet", "hard", "Cessna Citation Longitude");

// -----------------------------------------------------
// HELICOPTERS
// -----------------------------------------------------

addAircraft("bell-206", "Bell 206 JetRanger", ["Bell 206", "JetRanger"], "Helicopter", "medium", "Bell 206");
addAircraft("bell-407", "Bell 407", ["B407"], "Helicopter", "hard", "Bell 407");
addAircraft("bell-412", "Bell 412", ["B412"], "Helicopter", "hard", "Bell 412");
addAircraft("bell-429", "Bell 429", ["B429"], "Helicopter", "hard", "Bell 429");
addAircraft("bell-525", "Bell 525 Relentless", ["Bell 525", "Relentless"], "Helicopter", "expert", "Bell 525");
addAircraft("bell-ah1", "Bell AH-1 Cobra", ["AH-1", "Cobra"], "Helicopter", "medium", "Bell AH-1 Cobra");
addAircraft("bell-ah1z", "Bell AH-1Z Viper", ["AH-1Z", "Viper"], "Helicopter", "hard", "Bell AH-1Z Viper");

addAircraft("uh60", "Sikorsky UH-60 Black Hawk", ["UH-60", "UH60", "Black Hawk"], "Helicopter", "medium", "Sikorsky UH-60 Black Hawk");
addAircraft("ch47", "Boeing CH-47 Chinook", ["CH-47", "CH47", "Chinook"], "Helicopter", "medium", "Boeing CH-47 Chinook");
addAircraft("ah64", "Boeing AH-64 Apache", ["AH-64", "AH64", "Apache"], "Helicopter", "medium", "Boeing AH-64 Apache");
addAircraft("sikorsky-s76", "Sikorsky S-76", ["S76"], "Helicopter", "hard", "Sikorsky S-76");
addAircraft("sikorsky-s92", "Sikorsky S-92", ["S92"], "Helicopter", "hard", "Sikorsky S-92");
addAircraft("sikorsky-ch53", "Sikorsky CH-53 Sea Stallion", ["CH-53", "Sea Stallion"], "Helicopter", "hard", "Sikorsky CH-53 Sea Stallion");

addAircraft("apache-eurocopter", "Eurocopter AS350 Écureuil", ["AS350", "AStar", "Écureuil"], "Helicopter", "hard", "Eurocopter AS350 Écureuil");
addAircraft("h125", "Airbus H125", ["H125"], "Helicopter", "medium", "Eurocopter AS350 Écureuil");
addAircraft("h135", "Airbus H135", ["H135", "EC135"], "Helicopter", "medium", "Eurocopter EC135");
addAircraft("h145", "Airbus H145", ["H145", "EC145"], "Helicopter", "medium", "Eurocopter EC145");
addAircraft("h225", "Airbus H225 Super Puma", ["H225", "EC225", "Super Puma"], "Helicopter", "hard", "Eurocopter Super Puma");
addAircraft("aw139", "Leonardo AW139", ["AW139"], "Helicopter", "medium", "AgustaWestland AW139");
addAircraft("aw101", "Leonardo AW101 Merlin", ["AW101", "EH101", "Merlin"], "Helicopter", "hard", "AgustaWestland AW101");

// -----------------------------------------------------
// CARGO AND INTERNATIONAL AIRCRAFT
// -----------------------------------------------------

addAircraft("il76", "Ilyushin Il-76", ["Il-76", "IL76"], "Cargo", "hard", "Ilyushin Il-76");
addAircraft("il96", "Ilyushin Il-96", ["Il-96", "IL96"], "Commercial", "expert", "Ilyushin Il-96");
addAircraft("an12", "Antonov An-12", ["An-12", "AN12"], "Cargo", "hard", "Antonov An-12");
addAircraft("an22", "Antonov An-22", ["An-22", "AN22", "Antei"], "Cargo", "expert", "Antonov An-22");
addAircraft("an124", "Antonov An-124 Ruslan", ["An-124", "AN124", "Ruslan"], "Cargo", "medium", "Antonov An-124 Ruslan");
addAircraft("an225", "Antonov An-225 Mriya", ["An-225", "AN225", "Mriya"], "Historic", "easy", "Antonov An-225 Mriya");
addAircraft("tu134", "Tupolev Tu-134", ["Tu-134", "TU134"], "Historic", "expert", "Tupolev Tu-134");
addAircraft("tu154", "Tupolev Tu-154", ["Tu-154", "TU154"], "Historic", "hard", "Tupolev Tu-154");
addAircraft("tu204", "Tupolev Tu-204", ["Tu-204", "TU204"], "Commercial", "expert", "Tupolev Tu-204");
addAircraft("yak40", "Yakovlev Yak-40", ["Yak-40", "YAK40"], "Regional", "expert", "Yakovlev Yak-40");
addAircraft("yak42", "Yakovlev Yak-42", ["Yak-42", "YAK42"], "Regional", "expert", "Yakovlev Yak-42");
addAircraft("comac-c919", "COMAC C919", ["C919", "Comac 919"], "Commercial", "hard", "Comac C919");
addAircraft("comac-arj21", "COMAC ARJ21", ["ARJ21", "ARJ-21"], "Regional", "expert", "Comac ARJ21");
addAircraft("sukhoi-superjet", "Sukhoi Superjet 100", ["SSJ100", "Superjet 100"], "Regional", "hard", "Sukhoi Superjet 100");
addAircraft("mitsubishi-spacejet", "Mitsubishi SpaceJet", ["MRJ", "Mitsubishi Regional Jet"], "Regional", "expert", "Mitsubishi SpaceJet");
addAircraft("dornier228", "Dornier 228", ["Do 228", "DO228"], "Regional", "expert", "Dornier 228");
addAircraft("dornier328", "Dornier 328", ["Do 328", "DO328"], "Regional", "expert", "Dornier 328");
addAircraft("let410", "Let L-410 Turbolet", ["L-410", "L410", "Turbolet"], "Regional", "hard", "Let L-410 Turbolet");
addAircraft("embraer-c390", "Embraer C-390 Millennium", ["C-390", "KC-390", "Millennium"], "Military", "hard", "Embraer C-390 Millennium");
addAircraft("embraer-tucano", "Embraer EMB 312 Tucano", ["EMB 312", "Tucano"], "Military", "hard", "Embraer EMB 312 Tucano");
addAircraft("embraer-super-tucano", "Embraer EMB 314 Super Tucano", ["EMB 314", "A-29", "Super Tucano"], "Military", "medium", "Embraer EMB 314 Super Tucano");

addAircraft("airbus-beluga", "Airbus Beluga", ["A300-600ST", "Beluga"], "Cargo", "medium", "Airbus Beluga");
addAircraft("airbus-belugaxl", "Airbus BelugaXL", ["Beluga XL", "A330-743L"], "Cargo", "medium", "Airbus BelugaXL");
addAircraft("boeing-dreamlifter", "Boeing Dreamlifter", ["747 LCF", "Dreamlifter"], "Cargo", "hard", "Boeing Dreamlifter");
addAircraft("boeing-747-400f", "Boeing 747-400F", ["747-400F"], "Cargo", "medium", "Boeing 747");
addAircraft("boeing-747-8f", "Boeing 747-8F", ["747-8F", "747-8 Freighter"], "Cargo", "hard", "Boeing 747-8");

// -----------------------------------------------------
// AIRCRAFT CATALOGUE VALIDATION
// -----------------------------------------------------

const aircraftIds = new Set();

for (const aircraft of AIRCRAFT) {
    if (aircraftIds.has(aircraft.id)) {
        throw new Error(`Duplicate aircraft ID: ${aircraft.id}`);
    }

    aircraftIds.add(aircraft.id);
}

console.log(`Loaded ${AIRCRAFT.length} aircraft entries.`);

// =====================================================
// ACHIEVEMENTS
// =====================================================

const ACHIEVEMENTS = [
    {
        id: "first_spotting",
        name: "First Spotting",
        description: "Get your first correct answer.",
        type: "correct",
        target: 1
    },
    {
        id: "aviation_enthusiast",
        name: "Aviation Enthusiast",
        description: "Get 25 correct answers.",
        type: "correct",
        target: 25
    },
    {
        id: "aircraft_expert",
        name: "Aircraft Expert",
        description: "Get 100 correct answers.",
        type: "correct",
        target: 100
    },
    {
        id: "master_spotter",
        name: "Master Spotter",
        description: "Get 500 correct answers.",
        type: "correct",
        target: 500
    },
    {
        id: "perfect_run",
        name: "Perfect Run",
        description: "Reach a streak of 10 correct answers.",
        type: "streak",
        target: 10
    },
    {
        id: "unstoppable",
        name: "Unstoppable",
        description: "Reach a streak of 25 correct answers.",
        type: "streak",
        target: 25
    },
    {
        id: "century_streak",
        name: "Century Streak",
        description: "Reach a streak of 100 correct answers.",
        type: "streak",
        target: 100
    }
];

// =====================================================
// AIRCRAFT ANSWER CHECKING
// =====================================================

function normaliseAnswer(value) {
    return String(value)
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]/g, "");
}

function checkAnswer(input, aircraft) {
    const accepted = [
        aircraft.name,
        ...aircraft.aliases
    ];

    const normalised = normaliseAnswer(input);

    return accepted.some(
        answer => normaliseAnswer(answer) === normalised
    );
}

// =====================================================
// IMAGE LOOKUP
// =====================================================

const imageCache = new Map();

async function commonsSearch(aircraft, query) {
    const url = new URL(COMMONS_API);

    url.search = new URLSearchParams({
        action: "query",
        format: "json",
        generator: "search",
        gsrsearch: query,
        gsrnamespace: "6",
        gsrlimit: "20",
        prop: "imageinfo",
        iiprop: "url|size",
        iiurlwidth: "1600"
    }).toString();

    const response = await fetch(url, {
        headers: {
            "User-Agent": "PlaneSpotterDiscordBot/2.0 (aircraft identification game)"
        },
        signal: AbortSignal.timeout(IMAGE_TIMEOUT)
    });

    if (!response.ok) {
        throw new Error(`Commons returned HTTP ${response.status}`);
    }

    const data = await response.json();

    const pages = Object.values(data.query?.pages || {});

    const candidates = pages
        .map(page => {
            const info = page.imageinfo?.[0];

            if (!info?.thumburl) return null;

            const width = Number(info.width || 0);
            const height = Number(info.height || 0);

            if (!width || !height) return null;

            const ratio = width / height;

            // Prefer wide photographs which are more suitable
            // for showing an entire aircraft in the embed.

            if (ratio < 1.2) return null;
            if (width < 800) return null;

            const title = page.title || "";

            const titleScore =
                normaliseAnswer(title).includes(
                    normaliseAnswer(aircraft.name)
                ) ? 10 : 0;

            return {
                url: info.thumburl,
                width,
                height,
                ratio,
                score: titleScore + Math.min(width / 1000, 5)
            };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score);

    return candidates[0]?.url || null;
}

async function getAircraftImage(aircraft) {
    if (imageCache.has(aircraft.id)) {
        return imageCache.get(aircraft.id);
    }

    const queries = [
        `filetype:bitmap "${aircraft.name}" aircraft side view`,
        `filetype:bitmap "${aircraft.name}" aircraft`,
        `filetype:bitmap ${aircraft.wiki} airplane`
    ];

    for (const query of queries) {
        try {
            const image = await commonsSearch(aircraft, query);

            if (image) {
                imageCache.set(aircraft.id, image);
                return image;
            }
        } catch (error) {
            console.warn(
                `Image search failed for ${aircraft.name}: ${error.message}`
            );
        }
    }

    return null;
}

// =====================================================
// RANDOM AIRCRAFT SELECTION
// =====================================================

function getEligibleAircraft(difficulty) {
    if (difficulty === "mixed") {
        return AIRCRAFT;
    }

    const filtered = AIRCRAFT.filter(
        aircraft => aircraft.difficulty === difficulty
    );

    return filtered.length > 0 ? filtered : AIRCRAFT;
}

function shuffleArray(array) {
    const result = [...array];

    for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));

        [result[i], result[j]] = [
            result[j],
            result[i]
        ];
    }

    return result;
}

function getFreshAircraft(guildId, difficulty) {
    const eligible = getEligibleAircraft(difficulty);

    const used = db.prepare(`
        SELECT aircraft_id
        FROM aircraft_usage
        WHERE guild_id = ?
    `).all(guildId);

    const usedIds = new Set(
        used.map(row => row.aircraft_id)
    );

    let fresh = eligible.filter(
        aircraft => !usedIds.has(aircraft.id)
    );

    let rotationReset = false;

    // Only reset the eligible catalogue after every eligible
    // aircraft has been used by this server.

    if (fresh.length === 0) {
        const reset = db.prepare(`
            DELETE FROM aircraft_usage
            WHERE guild_id = ?
            AND aircraft_id = ?
        `);

        const resetTransaction = db.transaction(() => {
            for (const aircraft of eligible) {
                reset.run(guildId, aircraft.id);
            }
        });

        resetTransaction();

        fresh = eligible;
        rotationReset = true;
    }

    return {
        candidates: shuffleArray(fresh),
        rotationReset
    };
}

// =====================================================
// EMBEDS
// =====================================================

function makeGameEmbed(aircraft, imageUrl, questionNumber) {
    return new EmbedBuilder()
        .setColor(COLOUR)
        .setTitle("PLANESPOTTER  •  GUESS THE PLANE")
        .setDescription([
            "• A new aircraft has been selected.",
            "• Study the photograph carefully.",
            "• Submit the aircraft's name using the button below.",
            "",
            "**One correct answer earns one point.**"
        ].join("\n"))
        .setImage(imageUrl)
        .setFooter({
            text: `PlaneSpotter • Question ${questionNumber}`
        })
        .setTimestamp();
}

function makeRevealEmbed(aircraft, imageUrl, settings) {
    const description = settings.auto_reveal
        ? [
            "• This round has now ended.",
            "",
            `**Correct aircraft:** ${aircraft.name}`,
            "",
            "• Points have been awarded to everyone who answered correctly."
        ].join("\n")
        : [
            "• This round has now ended.",
            "• Answer submissions are closed."
        ].join("\n");

    return new EmbedBuilder()
        .setColor(COLOUR)
        .setTitle("PLANESPOTTER  •  ROUND FINISHED")
        .setDescription(description)
        .setImage(imageUrl)
        .setFooter({
            text: "PlaneSpotter • Thanks for playing"
        })
        .setTimestamp();
}

// =====================================================
// GAME SCHEDULING
// =====================================================

const schedulerTimers = new Map();
const revealTimers = new Map();

function clearScheduler(guildId) {
    const timer = schedulerTimers.get(guildId);

    if (timer) {
        clearTimeout(timer);
        schedulerTimers.delete(guildId);
    }
}

function clearRevealTimer(gameId) {
    const timer = revealTimers.get(gameId);

    if (timer) {
        clearTimeout(timer);
        revealTimers.delete(gameId);
    }
}

function scheduleNextQuestion(guildId, delay) {
    clearScheduler(guildId);

    const timer = setTimeout(async () => {
        schedulerTimers.delete(guildId);

        try {
            const posted = await postQuestion(guildId);

            if (posted) {
                startScheduler(guildId);
            } else {
                scheduleNextQuestion(guildId, RETRY_DELAY);
            }
        } catch (error) {
            console.error(
                `Could not post question for ${guildId}:`,
                error
            );

            scheduleNextQuestion(guildId, RETRY_DELAY);
        }
    }, Math.min(Math.max(delay, 1000), MAX_TIMER));

    schedulerTimers.set(guildId, timer);
}

function startScheduler(guildId) {
    clearScheduler(guildId);

    const settings = getSettings(guildId);

    if (!settings.enabled || !settings.channel_id) {
        return;
    }

    const interval = settings.interval_minutes * 60 * 1000;

    let nextPost = settings.last_post_at
        ? settings.last_post_at + interval
        : Date.now() + 3000;

    // Never replace a question while its answer window is active.

    const active = statements.activeGames.all(guildId);

    if (active.length > 0) {
        const earliestExpiry = Math.min(
            ...active.map(game => game.expires_at)
        );

        nextPost = Math.max(nextPost, earliestExpiry);
    }

    scheduleNextQuestion(
        guildId,
        Math.max(1000, nextPost - Date.now())
    );
}

// =====================================================
// POSTING A QUESTION
// =====================================================

const postingGuilds = new Set();

async function postQuestion(guildId) {
    if (postingGuilds.has(guildId)) {
        return false;
    }

    postingGuilds.add(guildId);

    try {
        const settings = getSettings(guildId);

        if (!settings.enabled || !settings.channel_id) {
            return false;
        }

        const activeGames = statements.activeGames.all(guildId);

        for (const game of activeGames) {
            if (Date.now() >= game.expires_at) {
                await revealGame(game.id);
            } else {
                return false;
            }
        }

        const channel = await client.channels.fetch(
            settings.channel_id
        ).catch(() => null);

        if (
            !channel ||
            !channel.isTextBased() ||
            !channel.send
        ) {
            console.error(
                `Invalid game channel for guild ${guildId}`
            );

            return false;
        }

        const selection = getFreshAircraft(
            guildId,
            settings.difficulty
        );

        let aircraft = null;
        let imageUrl = null;

        // Try different aircraft rather than repeatedly searching
        // for the same failed image.

        for (const candidate of selection.candidates) {
            const image = await getAircraftImage(candidate);

            if (image) {
                aircraft = candidate;
                imageUrl = image;
                break;
            }
        }

        if (!aircraft || !imageUrl) {
            console.warn(
                `No suitable aircraft image found for ${guildId}.`
            );

            return false;
        }

        const gameId = crypto.randomUUID();
        const now = Date.now();

        const expiresAt =
            now + (settings.answer_minutes * 60 * 1000);

        const questionNumber = db.prepare(`
            SELECT COUNT(*) AS total
            FROM games
            WHERE guild_id = ?
        `).get(guildId).total + 1;

        const embed = makeGameEmbed(
            aircraft,
            imageUrl,
            questionNumber
        );

        const button = new ButtonBuilder()
            .setCustomId(`answer:${gameId}`)
            .setLabel("Submit your answer")
            .setStyle(ButtonStyle.Primary);

        const row = new ActionRowBuilder()
            .addComponents(button);

        const message = await channel.send({
            embeds: [embed],
            components: [row]
        });

        // Save the game and mark the aircraft as used together.

        const saveGame = db.transaction(() => {
            statements.insertGame.run(
                gameId,
                guildId,
                channel.id,
                message.id,
                aircraft.id,
                aircraft.name,
                JSON.stringify(aircraft.aliases),
                imageUrl,
                now,
                expiresAt
            );

            db.prepare(`
                INSERT INTO aircraft_usage (
                    guild_id, aircraft_id, used_at
                )
                VALUES (?, ?, ?)
                ON CONFLICT(guild_id, aircraft_id)
                DO UPDATE SET used_at = excluded.used_at
            `).run(guildId, aircraft.id, now);

            statements.updateLastPost.run(now, guildId);
        });

        saveGame();

        scheduleReveal(gameId, expiresAt);

        console.log(
            `Posted ${aircraft.name} in ${guildId}`
        );

        return true;

    } finally {
        postingGuilds.delete(guildId);
    }
}

// =====================================================
// ROUND REVEAL
// =====================================================

function scheduleReveal(gameId, expiresAt) {
    clearRevealTimer(gameId);

    const delay = Math.max(
        1000,
        expiresAt - Date.now()
    );

    const timer = setTimeout(async () => {
        revealTimers.delete(gameId);
        await revealGame(gameId);
    }, Math.min(delay, MAX_TIMER));

    revealTimers.set(gameId, timer);
}

async function revealGame(gameId) {
    const game = statements.getGame.get(gameId);

    if (!game || game.status !== "active") {
        return;
    }

    clearRevealTimer(gameId);

    // Close the game in the database first. This prevents
    // late answers from being accepted during message editing.

    const closed = statements.closeGame.run(
        "revealed",
        gameId
    );

    if (closed.changes === 0) {
        return;
    }

    const settings = getSettings(game.guild_id);

    const aircraft = AIRCRAFT.find(
        item => item.id === game.aircraft_id
    );

    if (!aircraft) return;

    try {
        const channel = await client.channels.fetch(
            game.channel_id
        );

        const message = await channel.messages.fetch(
            game.message_id
        );

        const embed = makeRevealEmbed(
            aircraft,
            game.image_url,
            settings
        );

        await message.edit({
            embeds: [embed],
            components: []
        });

    } catch (error) {
        console.warn(
            `Could not edit game message ${gameId}:`,
            error.message
        );
    }
}

// =====================================================
// ANSWER MODAL
// =====================================================

function makeAnswerModal(gameId) {
    const modal = new ModalBuilder()
        .setCustomId(`answer-modal:${gameId}`)
        .setTitle("Identify the aircraft");

    const input = new TextInputBuilder()
        .setCustomId("aircraft_name")
        .setLabel("What aircraft is shown?")
        .setPlaceholder("Enter the aircraft name or model...")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(100);

    modal.addComponents(
        new ActionRowBuilder().addComponents(input)
    );

    return modal;
}

// =====================================================
// SETUP PANEL
// PRESERVED FROM YOUR ORIGINAL FILE
// =====================================================

function makeSetupEmbed(settings) {
    const channel = settings.channel_id
        ? `<#${settings.channel_id}>`
        : "Not selected";

    const status = settings.enabled
        ? "Enabled"
        : "Disabled";

    const reveal = settings.auto_reveal
        ? "Enabled"
        : "Disabled";

    return new EmbedBuilder()
        .setColor(COLOUR)
        .setTitle("PLANESPOTTER  •  SERVER CONFIGURATION")
        .setDescription([
            "Configure automatic aircraft challenges for your server.",
            "",
            "**Current configuration**",
            `• Game channel: ${channel}`,
            `• Posting interval: ${settings.interval_minutes} minutes`,
            `• Answer duration: ${settings.answer_minutes} minutes`,
            `• Difficulty: ${settings.difficulty}`,
            `• Automatic reveal: ${reveal}`,
            `• Game status: ${status}`,
            "",
            "Use the controls below to update your settings."
        ].join("\n"))
        .setFooter({
            text: "PlaneSpotter • Administrator settings"
        })
        .setTimestamp();
}

function makeSetupComponents(settings) {
    const channelSelect = new ChannelSelectMenuBuilder()
        .setCustomId("setup:channel")
        .setPlaceholder("Select the aircraft game channel")
        .setChannelTypes(ChannelType.GuildText);

    const intervalSelect = new StringSelectMenuBuilder()
        .setCustomId("setup:interval")
        .setPlaceholder("Choose posting interval")
        .addOptions(
            [
                ["5 minutes", "5"],
                ["15 minutes", "15"],
                ["30 minutes", "30"],
                ["1 hour", "60"],
                ["2 hours", "120"],
                ["6 hours", "360"],
                ["12 hours", "720"],
                ["24 hours", "1440"]
            ].map(([label, value]) => ({
                label,
                value,
                default: settings.interval_minutes === Number(value)
            }))
        );

    const durationSelect = new StringSelectMenuBuilder()
        .setCustomId("setup:duration")
        .setPlaceholder("Choose answer submission duration")
        .addOptions(
            [
                ["1 minute", "1"],
                ["5 minutes", "5"],
                ["10 minutes", "10"],
                ["15 minutes", "15"],
                ["30 minutes", "30"],
                ["60 minutes", "60"]
            ].map(([label, value]) => ({
                label,
                value,
                default: settings.answer_minutes === Number(value)
            }))
        );

    const difficultySelect = new StringSelectMenuBuilder()
        .setCustomId("setup:difficulty")
        .setPlaceholder("Choose aircraft difficulty")
        .addOptions(
            [
                {
                    label: "Mixed difficulty",
                    value: "mixed",
                    description: "A mixture of aircraft difficulties",
                    default: settings.difficulty === "mixed"
                },
                {
                    label: "Medium",
                    value: "medium",
                    description: "Moderately challenging aircraft",
                    default: settings.difficulty === "medium"
                },
                {
                    label: "Hard",
                    value: "hard",
                    description: "Less familiar aircraft",
                    default: settings.difficulty === "hard"
                },
                {
                    label: "Expert",
                    value: "expert",
                    description: "More obscure aircraft",
                    default: settings.difficulty === "expert"
                }
            ]
        );

    const enabledButton = new ButtonBuilder()
        .setCustomId("setup:enabled")
        .setLabel(
            settings.enabled ? "Disable game" : "Enable game"
        )
        .setStyle(
            settings.enabled
                ? ButtonStyle.Danger
                : ButtonStyle.Success
        );

    const revealButton = new ButtonBuilder()
        .setCustomId("setup:reveal")
        .setLabel(
            settings.auto_reveal
                ? "Turn off answer reveal"
                : "Turn on answer reveal"
        )
        .setStyle(ButtonStyle.Secondary);

    return [
        new ActionRowBuilder().addComponents(channelSelect),
        new ActionRowBuilder().addComponents(intervalSelect),
        new ActionRowBuilder().addComponents(durationSelect),
        new ActionRowBuilder().addComponents(difficultySelect),
        new ActionRowBuilder().addComponents(
            enabledButton,
            revealButton
        )
    ];
}

async function refreshSetup(interaction) {
    const settings = getSettings(interaction.guildId);

    await interaction.update({
        embeds: [makeSetupEmbed(settings)],
        components: makeSetupComponents(settings)
    });

    startScheduler(interaction.guildId);
}

// =====================================================
// SCORING AND STREAKS
// =====================================================

function getPlayerStreak(guildId, userId) {
    return statements.getStreak.get(guildId, userId) || {
        current_streak: 0,
        longest_streak: 0
    };
}

function getCorrectAnswerCount(guildId, userId) {
    return db.prepare(`
        SELECT COUNT(*) AS total
        FROM score_events
        WHERE guild_id = ? AND user_id = ?
    `).get(guildId, userId).total;
}

function unlockEligibleAchievements(
    guildId,
    userId,
    correctCount,
    longestStreak,
    now
) {
    const unlocked = [];

    for (const achievement of ACHIEVEMENTS) {
        const progress = achievement.type === "correct"
            ? correctCount
            : longestStreak;

        if (progress >= achievement.target) {
            const result = statements.addAchievement.run(
                guildId,
                userId,
                achievement.id,
                now
            );

            if (result.changes > 0) {
                unlocked.push(achievement);
            }
        }
    }

    return unlocked;
}

const recordAnswer = db.transaction((
    game,
    userId,
    submittedAnswer,
    correct
) => {
    const now = Date.now();

    statements.insertAttempt.run(
        game.id,
        game.guild_id,
        userId,
        submittedAnswer,
        correct ? 1 : 0,
        now
    );

    if (correct) {
        statements.addScore.run(
            game.guild_id,
            userId,
            now
        );
    }

    const previous = getPlayerStreak(
        game.guild_id,
        userId
    );

    const currentStreak = correct
        ? previous.current_streak + 1
        : 0;

    const longestStreak = Math.max(
        previous.longest_streak,
        currentStreak
    );

    statements.saveStreak.run(
        game.guild_id,
        userId,
        currentStreak,
        longestStreak,
        now
    );

    const correctCount = getCorrectAnswerCount(
        game.guild_id,
        userId
    );

    const unlocked = unlockEligibleAchievements(
        game.guild_id,
        userId,
        correctCount,
        longestStreak,
        now
    );

    return {
        currentStreak,
        longestStreak,
        correctCount,
        unlocked
    };
});

// =====================================================
// LEADERBOARD
// =====================================================

function getLeaderboard(guildId, scope, period) {
    const since = period === "weekly"
        ? Date.now() - (7 * 24 * 60 * 60 * 1000)
        : 0;

    if (scope === "global") {
        return db.prepare(`
            SELECT
                user_id,
                SUM(points) AS points,
                COUNT(*) AS correct_answers
            FROM score_events
            WHERE created_at >= ?
            GROUP BY user_id
            ORDER BY points DESC, correct_answers DESC
            LIMIT 10
        `).all(since);
    }

    return db.prepare(`
        SELECT
            user_id,
            SUM(points) AS points,
            COUNT(*) AS correct_answers
        FROM score_events
        WHERE guild_id = ?
        AND created_at >= ?
        GROUP BY user_id
        ORDER BY points DESC, correct_answers DESC
        LIMIT 10
    `).all(guildId, since);
}

function makeLeaderboardEmbed(rows, scope, period) {
    const scopeName = scope === "global"
        ? "GLOBAL"
        : "SERVER";

    const periodName = period === "weekly"
        ? "WEEKLY"
        : "ALL-TIME";

    let description;

    if (rows.length === 0) {
        description = "• No scores have been recorded yet.";
    } else {
        description = rows.map((row, index) => {
            const position = index + 1;

            const medal = {
                1: "🥇",
                2: "🥈",
                3: "🥉"
            }[position] || `**${position}.**`;

            return [
                `${medal} <@${row.user_id}>`,
                `• **${row.points} points**`,
                `• ${row.correct_answers} correct answers`
            ].join("\n");
        }).join("\n\n");
    }

    return new EmbedBuilder()
        .setColor(COLOUR)
        .setTitle(
            `PLANESPOTTER  •  ${scopeName} LEADERBOARD`
        )
        .setDescription(description)
        .setFooter({
            text: `${periodName} rankings • Top 10 players`
        })
        .setTimestamp();
}

// =====================================================
// PLAYER PROFILES
// =====================================================

function makeProfileEmbed(user, guildId) {
    const stats = db.prepare(`
        SELECT
            COALESCE(SUM(points), 0) AS points,
            COUNT(*) AS correct_answers
        FROM score_events
        WHERE guild_id = ? AND user_id = ?
    `).get(guildId, user.id);

    const attempts = db.prepare(`
        SELECT
            COUNT(*) AS total,
            COALESCE(SUM(correct), 0) AS correct
        FROM attempts
        WHERE guild_id = ? AND user_id = ?
    `).get(guildId, user.id);

    const streak = getPlayerStreak(
        guildId,
        user.id
    );

    const totalAttempts = attempts.total || 0;
    const correct = attempts.correct || 0;

    const accuracy = totalAttempts > 0
        ? Math.round((correct / totalAttempts) * 100)
        : 0;

    return new EmbedBuilder()
        .setColor(COLOUR)
        .setTitle("PLANESPOTTER  •  PLAYER PROFILE")
        .setThumbnail(user.displayAvatarURL())
        .setDescription([
            `**Player:** ${user.username}`,
            "",
            `• Points: **${stats.points}**`,
            `• Correct answers: **${stats.correct_answers}**`,
            `• Total attempts: **${totalAttempts}**`,
            `• Accuracy: **${accuracy}%**`,
            "",
            "**Streak statistics**",
            `• Current streak: **${streak.current_streak}**`,
            `• Longest streak: **${streak.longest_streak}**`
        ].join("\n"))
        .setFooter({
            text: "PlaneSpotter • Player statistics"
        })
        .setTimestamp();
}

// =====================================================
// STREAK COMMAND
// =====================================================

function makeStreakEmbed(user, guildId) {
    const streak = getPlayerStreak(
        guildId,
        user.id
    );

    return new EmbedBuilder()
        .setColor(COLOUR)
        .setTitle("PLANESPOTTER  •  PLAYER STREAK")
        .setThumbnail(user.displayAvatarURL())
        .setDescription([
            `**Player:** ${user.username}`,
            "",
            `• Current streak: **${streak.current_streak}**`,
            `• Longest streak: **${streak.longest_streak}**`,
            "",
            "A correct answer increases your streak.",
            "An incorrect answer resets your current streak."
        ].join("\n"))
        .setFooter({
            text: "PlaneSpotter • Streak statistics"
        })
        .setTimestamp();
}

// =====================================================
// ACHIEVEMENTS COMMAND
// =====================================================

function makeAchievementsEmbed(user, guildId) {
    const correctCount = getCorrectAnswerCount(
        guildId,
        user.id
    );

    const streak = getPlayerStreak(
        guildId,
        user.id
    );

    const unlockedRows = db.prepare(`
        SELECT achievement_id, unlocked_at
        FROM user_achievements
        WHERE guild_id = ? AND user_id = ?
    `).all(guildId, user.id);

    const unlockedMap = new Map(
        unlockedRows.map(row => [
            row.achievement_id,
            row.unlocked_at
        ])
    );

    const lines = ACHIEVEMENTS.map(achievement => {
        const progress = achievement.type === "correct"
            ? correctCount
            : streak.longest_streak;

        const unlockedAt = unlockedMap.get(
            achievement.id
        );

        const status = unlockedAt
            ? "UNLOCKED"
            : `${Math.min(progress, achievement.target)}/${achievement.target}`;

        return [
            `**${achievement.name}**`,
            `• ${achievement.description}`,
            `• Progress: ${status}`
        ].join("\n");
    });

    const unlockedCount = unlockedMap.size;

    return new EmbedBuilder()
        .setColor(COLOUR)
        .setTitle("PLANESPOTTER  •  ACHIEVEMENTS")
        .setThumbnail(user.displayAvatarURL())
        .setDescription([
            `**Player:** ${user.username}`,
            `**Achievements unlocked:** ${unlockedCount}/${ACHIEVEMENTS.length}`,
            "",
            lines.join("\n\n")
        ].join("\n"))
        .setFooter({
            text: "PlaneSpotter • Achievement collection"
        })
        .setTimestamp();
}

// =====================================================
// SLASH COMMANDS
// =====================================================

const commands = [
    new SlashCommandBuilder()
        .setName("setup")
        .setDescription("Configure PlaneSpotter for this server")
        .setDefaultMemberPermissions(
            PermissionFlagsBits.Administrator
        ),

    new SlashCommandBuilder()
        .setName("leaderboard")
        .setDescription("View PlaneSpotter player rankings")
        .addStringOption(option =>
            option
                .setName("scope")
                .setDescription("Choose leaderboard")
                .setRequired(false)
                .addChoices(
                    { name: "Server", value: "server" },
                    { name: "Global", value: "global" }
                )
        )
        .addStringOption(option =>
            option
                .setName("period")
                .setDescription("Choose ranking period")
                .setRequired(false)
                .addChoices(
                    { name: "All-time", value: "alltime" },
                    { name: "Weekly", value: "weekly" }
                )
        ),

    new SlashCommandBuilder()
        .setName("profile")
        .setDescription("View a player's PlaneSpotter statistics")
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription("Player to view")
                .setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName("help")
        .setDescription("View PlaneSpotter commands"),

    new SlashCommandBuilder()
        .setName("streak")
        .setDescription("View a player's correct-answer streak")
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription("Player to view")
                .setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName("achievements")
        .setDescription("View a player's achievements")
        .addUserOption(option =>
            option
                .setName("user")
                .setDescription("Player to view")
                .setRequired(false)
        )
].map(command => command.toJSON());

// =====================================================
// COMMAND REGISTRATION
// =====================================================

async function registerCommands() {
    const rest = new REST({ version: "10" })
        .setToken(TOKEN);

    const route = GUILD_ID
        ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
        : Routes.applicationCommands(CLIENT_ID);

    await rest.put(route, {
        body: commands
    });

    console.log(
        `Registered ${commands.length} slash commands.`
    );
}

// =====================================================
// INTERACTION HANDLING
// =====================================================

client.on("interactionCreate", async interaction => {
    try {

        // ------------------------------
        // SLASH COMMANDS
        // ------------------------------

        if (interaction.isChatInputCommand()) {
            if (!interaction.guildId) {
                return interaction.reply({
                    content: "PlaneSpotter must be used inside a server.",
                    ephemeral: true
                });
            }

            if (interaction.commandName === "setup") {
                if (!interaction.memberPermissions?.has(
                    PermissionFlagsBits.Administrator
                )) {
                    return interaction.reply({
                        content: "You need Administrator permissions to configure PlaneSpotter.",
                        ephemeral: true
                    });
                }

                const settings = getSettings(interaction.guildId);

                return interaction.reply({
                    embeds: [makeSetupEmbed(settings)],
                    components: makeSetupComponents(settings),
                    ephemeral: true
                });
            }

            if (interaction.commandName === "leaderboard") {
                const scope =
                    interaction.options.getString("scope") || "server";

                const period =
                    interaction.options.getString("period") || "alltime";

                const rows = getLeaderboard(
                    interaction.guildId,
                    scope,
                    period
                );

                return interaction.reply({
                    embeds: [
                        makeLeaderboardEmbed(rows, scope, period)
                    ]
                });
            }

            if (interaction.commandName === "profile") {
                const user =
                    interaction.options.getUser("user") ||
                    interaction.user;

                return interaction.reply({
                    embeds: [
                        makeProfileEmbed(user, interaction.guildId)
                    ]
                });
            }

            if (interaction.commandName === "streak") {
                const user =
                    interaction.options.getUser("user") ||
                    interaction.user;

                return interaction.reply({
                    embeds: [
                        makeStreakEmbed(user, interaction.guildId)
                    ]
                });
            }

            if (interaction.commandName === "achievements") {
                const user =
                    interaction.options.getUser("user") ||
                    interaction.user;

                return interaction.reply({
                    embeds: [
                        makeAchievementsEmbed(user, interaction.guildId)
                    ]
                });
            }

            if (interaction.commandName === "help") {
                const embed = new EmbedBuilder()
                    .setColor(COLOUR)
                    .setTitle("PLANESPOTTER  •  COMMANDS")
                    .setDescription([
                        "**Available commands**",
                        "",
                        "• `/setup` — Configure the bot (administrators).",
                        "• `/leaderboard` — View server and global rankings.",
                        "• `/profile` — View player statistics.",
                        "• `/help` — View this command guide.",
                        "• `/streak` — View current and longest streaks.",
                        "• `/achievements` — View unlocked achievements.",
                        "",
                        "**How to play**",
                        "• Look at the aircraft photograph.",
                        "• Press Submit your answer.",
                        "• Enter the aircraft's name.",
                        "• Earn one point for a correct answer."
                    ].join("\n"))
                    .setFooter({
                        text: "PlaneSpotter • Aviation identification"
                    });

                return interaction.reply({
                    embeds: [embed],
                    ephemeral: true
                });
            }
        }

        // ------------------------------
        // SETUP COMPONENTS
        // ------------------------------

        if (
            interaction.isChannelSelectMenu() &&
            interaction.customId === "setup:channel"
        ) {
            if (!interaction.memberPermissions?.has(
                PermissionFlagsBits.Administrator
            )) {
                return interaction.reply({
                    content: "Administrator permissions are required.",
                    ephemeral: true
                });
            }

            const settings = getSettings(interaction.guildId);

            settings.channel_id = interaction.values[0];

            updateSettings(interaction.guildId, settings);

            return refreshSetup(interaction);
        }

        if (
            interaction.isStringSelectMenu() &&
            interaction.customId.startsWith("setup:")
        ) {
            if (!interaction.memberPermissions?.has(
                PermissionFlagsBits.Administrator
            )) {
                return interaction.reply({
                    content: "Administrator permissions are required.",
                    ephemeral: true
                });
            }

            const settings = getSettings(interaction.guildId);
            const value = interaction.values[0];

            switch (interaction.customId) {
                case "setup:interval":
                    settings.interval_minutes = Number(value);
                    break;

                case "setup:duration":
                    settings.answer_minutes = Number(value);
                    break;

                case "setup:difficulty":
                    settings.difficulty = value;
                    break;

                default:
                    return;
            }

            updateSettings(interaction.guildId, settings);

            return refreshSetup(interaction);
        }

        if (
            interaction.isButton() &&
            interaction.customId.startsWith("setup:")
        ) {
            if (!interaction.memberPermissions?.has(
                PermissionFlagsBits.Administrator
            )) {
                return interaction.reply({
                    content: "Administrator permissions are required.",
                    ephemeral: true
                });
            }

            const settings = getSettings(interaction.guildId);

            if (interaction.customId === "setup:enabled") {
                settings.enabled = settings.enabled ? 0 : 1;
            }

            if (interaction.customId === "setup:reveal") {
                settings.auto_reveal = settings.auto_reveal ? 0 : 1;
            }

            updateSettings(interaction.guildId, settings);

            return refreshSetup(interaction);
        }

        // ------------------------------
        // ANSWER BUTTON
        // ------------------------------

        if (
            interaction.isButton() &&
            interaction.customId.startsWith("answer:")
        ) {
            const gameId = interaction.customId.slice(7);
            const game = statements.getGame.get(gameId);

            if (!game || game.status !== "active") {
                return interaction.reply({
                    content: "This aircraft challenge has already ended.",
                    ephemeral: true
                });
            }

            if (Date.now() >= game.expires_at) {
                await revealGame(gameId);

                return interaction.reply({
                    content: "The submission period has ended.",
                    ephemeral: true
                });
            }

            const existing = db.prepare(`
                SELECT 1 FROM attempts
                WHERE game_id = ? AND user_id = ?
            `).get(gameId, interaction.user.id);

            if (existing) {
                return interaction.reply({
                    content: "You have already submitted an answer for this aircraft.",
                    ephemeral: true
                });
            }

            return interaction.showModal(
                makeAnswerModal(gameId)
            );
        }

        // ------------------------------
        // ANSWER SUBMISSION
        // ------------------------------

        if (
            interaction.isModalSubmit() &&
            interaction.customId.startsWith("answer-modal:")
        ) {
            const gameId = interaction.customId.slice(13);
            const game = statements.getGame.get(gameId);

            if (!game || game.status !== "active") {
                return interaction.reply({
                    content: "This aircraft challenge has ended.",
                    ephemeral: true
                });
            }

            if (Date.now() >= game.expires_at) {
                await revealGame(gameId);

                return interaction.reply({
                    content: "The submission period has ended.",
                    ephemeral: true
                });
            }

            const existing = db.prepare(`
                SELECT 1 FROM attempts
                WHERE game_id = ? AND user_id = ?
            `).get(gameId, interaction.user.id);

            if (existing) {
                return interaction.reply({
                    content: "You have already submitted an answer.",
                    ephemeral: true
                });
            }

            const submittedAnswer = interaction.fields
                .getTextInputValue("aircraft_name")
                .trim();

            const aircraft = AIRCRAFT.find(
                item => item.id === game.aircraft_id
            );

            if (!aircraft) {
                return interaction.reply({
                    content: "The aircraft information could not be found.",
                    ephemeral: true
                });
            }

            const correct = checkAnswer(
                submittedAnswer,
                aircraft
            );

            // Recheck the game inside the transaction.
            // This prevents late submissions and duplicate points.

            let result;

            try {
                result = recordAnswer(
                    game,
                    interaction.user.id,
                    submittedAnswer,
                    correct
                );
            } catch (error) {
                if (
                    error.code === "SQLITE_CONSTRAINT_PRIMARYKEY"
                ) {
                    return interaction.reply({
                        content: "You have already submitted an answer.",
                        ephemeral: true
                    });
                }

                throw error;
            }

            if (correct) {
                const achievementMessage =
                    result.unlocked.length > 0
                        ? [
                            "",
                            "**New achievements unlocked:**",
                            ...result.unlocked.map(
                                achievement => `• ${achievement.name}`
                            )
                        ].join("\n")
                        : "";

                return interaction.reply({
                    content: [
                        "Correct! You identified the aircraft.",
                        "",
                        "• **1 point** has been added to your server leaderboard.",
                        `• Current streak: **${result.currentStreak}**`,
                        "• Use `/leaderboard` to check your position.",
                        "• Use `/profile` to view your statistics.",
                        achievementMessage
                    ].filter(Boolean).join("\n"),
                    ephemeral: true
                });
            }

            return interaction.reply({
                content: [
                    "That answer isn't correct.",
                    "",
                    "• Your submission has been recorded.",
                    "• Your current streak has been reset.",
                    "• You can try again in the next aircraft challenge."
                ].join("\n"),
                ephemeral: true
            });
        }

    } catch (error) {
        console.error("Interaction error:", error);

        const response = {
            content: "Something went wrong while processing that interaction.",
            ephemeral: true
        };

        if (interaction.replied || interaction.deferred) {
            await interaction.followUp(response).catch(() => {});
        } else {
            await interaction.reply(response).catch(() => {});
        }
    }
});

// =====================================================
// STARTUP AND RESTORE
// =====================================================

async function restoreGames() {
    const activeGames = db.prepare(`
        SELECT id, expires_at
        FROM games
        WHERE status = 'active'
    `).all();

    for (const game of activeGames) {
        scheduleReveal(game.id, game.expires_at);
    }

    console.log(
        `Restored ${activeGames.length} active aircraft challenges.`
    );
}

async function restoreSchedulers() {
    const guilds = db.prepare(`
        SELECT guild_id
        FROM guild_settings
        WHERE enabled = 1 AND channel_id IS NOT NULL
    `).all();

    for (const guild of guilds) {
        startScheduler(guild.guild_id);
    }

    console.log(
        `Restored ${guilds.length} automatic game schedules.`
    );
}

// =====================================================
// CLIENT EVENTS
// =====================================================

client.once("ready", async () => {
    console.log("--------------------------------");
    console.log("PlaneSpotter is online.");
    console.log(`Logged in as ${client.user.tag}`);
    console.log(`Aircraft in catalogue: ${AIRCRAFT.length}`);
    console.log(`Achievements available: ${ACHIEVEMENTS.length}`);
    console.log("--------------------------------");

    await restoreGames();
    await restoreSchedulers();
});

client.on("error", error => {
    console.error("Discord client error:", error);
});

process.on("unhandledRejection", error => {
    console.error("Unhandled rejection:", error);
});

process.on("uncaughtException", error => {
    console.error("Uncaught exception:", error);
});

// =====================================================
// LOGIN
// =====================================================

(async () => {
    try {
        await registerCommands();
        await client.login(TOKEN);
    } catch (error) {
        console.error("PlaneSpotter failed to start:", error);
        process.exit(1);
    }
})();
