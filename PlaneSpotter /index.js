
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

const WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php";
const COMMONS_API = "https://commons.wikimedia.org/w/api.php";

const DEFAULT_INTERVAL = 30;
const DEFAULT_DURATION = 10;
const MAX_TIMER = 2147483647;

const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

const db = new Database(DATABASE_FILE);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

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
        UPDATE games SET status = ?
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

// Each aircraft has a unique ID, recognised name,
// accepted alternative answers, category and Wikipedia page.
//
// Add more aircraft to this array whenever you want.

const AIRCRAFT = [

    // AIRBUS
    {
        id: "airbus-a300",
        name: "Airbus A300",
        aliases: ["A300", "Airbus A300B"],
        category: "Commercial",
        difficulty: "medium",
        wiki: "Airbus A300"
    },
    {
        id: "airbus-a310",
        name: "Airbus A310",
        aliases: ["A310"],
        category: "Commercial",
        difficulty: "medium",
        wiki: "Airbus A310"
    },
    {
        id: "airbus-a318",
        name: "Airbus A318",
        aliases: ["A318", "Baby Bus"],
        category: "Commercial",
        difficulty: "medium",
        wiki: "Airbus A318"
    },
    {
        id: "airbus-a319",
        name: "Airbus A319",
        aliases: ["A319", "A319-100"],
        category: "Commercial",
        difficulty: "easy",
        wiki: "Airbus A319"
    },
    {
        id: "airbus-a320",
        name: "Airbus A320",
        aliases: ["A320", "A320-200"],
        category: "Commercial",
        difficulty: "easy",
        wiki: "Airbus A320 family"
    },
    {
        id: "airbus-a321",
        name: "Airbus A321",
        aliases: ["A321", "A321-200"],
        category: "Commercial",
        difficulty: "easy",
        wiki: "Airbus A321"
    },
    {
        id: "airbus-a320neo",
        name: "Airbus A320neo",
        aliases: ["A320neo", "A320 NEO"],
        category: "Commercial",
        difficulty: "medium",
        wiki: "Airbus A320neo family"
    },
    {
        id: "airbus-a321neo",
        name: "Airbus A321neo",
        aliases: ["A321neo", "A321 NEO"],
        category: "Commercial",
        difficulty: "medium",
        wiki: "Airbus A321neo"
    },
    {
        id: "airbus-a330",
        name: "Airbus A330",
        aliases: ["A330", "A330-300"],
        category: "Commercial",
        difficulty: "medium",
        wiki: "Airbus A330"
    },
    {
        id: "airbus-a330neo",
        name: "Airbus A330neo",
        aliases: ["A330neo", "A330-900"],
        category: "Commercial",
        difficulty: "hard",
        wiki: "Airbus A330neo"
    },
    {
        id: "airbus-a340",
        name: "Airbus A340",
        aliases: ["A340", "A340-300"],
        category: "Commercial",
        difficulty: "medium",
        wiki: "Airbus A340"
    },
    {
        id: "airbus-a350",
        name: "Airbus A350",
        aliases: ["A350", "A350-900"],
        category: "Commercial",
        difficulty: "easy",
        wiki: "Airbus A350"
    },
    {
        id: "airbus-a380",
        name: "Airbus A380",
        aliases: ["A380", "Superjumbo"],
        category: "Commercial",
        difficulty: "easy",
        wiki: "Airbus A380"
    },

    // BOEING
    {
        id: "boeing-707",
        name: "Boeing 707",
        aliases: ["707", "B707"],
        category: "Historic",
        difficulty: "medium",
        wiki: "Boeing 707"
    },
    {
        id: "boeing-717",
        name: "Boeing 717",
        aliases: ["717", "MD-95", "MD95"],
        category: "Commercial",
        difficulty: "hard",
        wiki: "Boeing 717"
    },
    {
        id: "boeing-727",
        name: "Boeing 727",
        aliases: ["727", "B727"],
        category: "Historic",
        difficulty: "medium",
        wiki: "Boeing 727"
    },
    {
        id: "boeing-737-200",
        name: "Boeing 737-200",
        aliases: ["737-200", "737 200"],
        category: "Historic",
        difficulty: "hard",
        wiki: "Boeing 737"
    },
    {
        id: "boeing-737-300",
        name: "Boeing 737-300",
        aliases: ["737-300", "737 300"],
        category: "Historic",
        difficulty: "hard",
        wiki: "Boeing 737"
    },
    {
        id: "boeing-737-800",
        name: "Boeing 737-800",
        aliases: ["737-800", "737 800", "B738"],
        category: "Commercial",
        difficulty: "medium",
        wiki: "Boeing 737 Next Generation"
    },
    {
        id: "boeing-737-max8",
        name: "Boeing 737 MAX 8",
        aliases: ["737 MAX 8", "737MAX8", "Boeing 737 MAX"],
        category: "Commercial",
        difficulty: "medium",
        wiki: "Boeing 737 MAX"
    },
    {
        id: "boeing-747-100",
        name: "Boeing 747-100",
        aliases: ["747-100", "747 100"],
        category: "Historic",
        difficulty: "hard",
        wiki: "Boeing 747"
    },
    {
        id: "boeing-747-400",
        name: "Boeing 747-400",
        aliases: ["747-400", "747 400"],
        category: "Commercial",
        difficulty: "medium",
        wiki: "Boeing 747"
    },
    {
        id: "boeing-747-8",
        name: "Boeing 747-8",
        aliases: ["747-8", "747 8", "747-8i"],
        category: "Commercial",
        difficulty: "hard",
        wiki: "Boeing 747-8"
    },
    {
        id: "boeing-757",
        name: "Boeing 757",
        aliases: ["757", "B757", "757-200"],
        category: "Commercial",
        difficulty: "medium",
        wiki: "Boeing 757"
    },
    {
        id: "boeing-767",
        name: "Boeing 767",
        aliases: ["767", "B767", "767-300"],
        category: "Commercial",
        difficulty: "medium",
        wiki: "Boeing 767"
    },
    {
        id: "boeing-777",
        name: "Boeing 777",
        aliases: ["777", "B777", "777-300ER"],
        category: "Commercial",
        difficulty: "easy",
        wiki: "Boeing 777"
    },
    {
        id: "boeing-787",
        name: "Boeing 787 Dreamliner",
        aliases: ["787", "B787", "787 Dreamliner", "Dreamliner"],
        category: "Commercial",
        difficulty: "easy",
        wiki: "Boeing 787 Dreamliner"
    },

    // DOUGLAS AND MCDONNELL DOUGLAS
    {
        id: "dc3",
        name: "Douglas DC-3",
        aliases: ["DC-3", "DC3", "Dakota", "C-47"],
        category: "Historic",
        difficulty: "medium",
        wiki: "Douglas DC-3"
    },
    {
        id: "dc8",
        name: "Douglas DC-8",
        aliases: ["DC-8", "DC8"],
        category: "Historic",
        difficulty: "hard",
        wiki: "Douglas DC-8"
    },
    {
        id: "dc9",
        name: "Douglas DC-9",
        aliases: ["DC-9", "DC9"],
        category: "Historic",
        difficulty: "hard",
        wiki: "Douglas DC-9"
    },
    {
        id: "dc10",
        name: "McDonnell Douglas DC-10",
        aliases: ["DC-10", "DC10"],
        category: "Historic",
        difficulty: "medium",
        wiki: "McDonnell Douglas DC-10"
    },
    {
        id: "md11",
        name: "McDonnell Douglas MD-11",
        aliases: ["MD-11", "MD11"],
        category: "Commercial",
        difficulty: "hard",
        wiki: "McDonnell Douglas MD-11"
    },
    {
        id: "md80",
        name: "McDonnell Douglas MD-80",
        aliases: ["MD-80", "MD80", "MD-82", "MD-83"],
        category: "Historic",
        difficulty: "hard",
        wiki: "McDonnell Douglas MD-80"
    },

    // BRITISH AND EUROPEAN AIRCRAFT
    {
        id: "concorde",
        name: "Concorde",
        aliases: ["Aérospatiale-BAC Concorde", "BAC Concorde"],
        category: "Historic",
        difficulty: "easy",
        wiki: "Concorde"
    },
    {
        id: "comet",
        name: "de Havilland Comet",
        aliases: ["DH.106 Comet", "Comet"],
        category: "Historic",
        difficulty: "hard",
        wiki: "De Havilland Comet"
    },
    {
        id: "avro-rj85",
        name: "Avro RJ85",
        aliases: ["RJ85", "BAe 146-200"],
        category: "Regional",
        difficulty: "hard",
        wiki: "Avro RJ85"
    },
    {
        id: "bae146",
        name: "British Aerospace 146",
        aliases: ["BAe 146", "BAE146", "Whisperjet"],
        category: "Regional",
        difficulty: "hard",
        wiki: "British Aerospace 146"
    },
    {
        id: "fokker100",
        name: "Fokker 100",
        aliases: ["F100", "Fokker F100"],
        category: "Regional",
        difficulty: "hard",
        wiki: "Fokker 100"
    },
    {
        id: "fokker70",
        name: "Fokker 70",
        aliases: ["F70"],
        category: "Regional",
        difficulty: "hard",
        wiki: "Fokker 70"
    },
    {
        id: "atr42",
        name: "ATR 42",
        aliases: ["ATR42", "ATR-42"],
        category: "Regional",
        difficulty: "medium",
        wiki: "ATR 42"
    },
    {
        id: "atr72",
        name: "ATR 72",
        aliases: ["ATR72", "ATR-72"],
        category: "Regional",
        difficulty: "easy",
        wiki: "ATR 72"
    },
    {
        id: "dash8",
        name: "De Havilland Canada Dash 8",
        aliases: ["Dash 8", "Q400", "DHC-8", "Dash 8 Q400"],
        category: "Regional",
        difficulty: "medium",
        wiki: "De Havilland Canada Dash 8"
    },

    // EMBRAER AND BOMBARDIER
    {
        id: "embraer-e170",
        name: "Embraer E170",
        aliases: ["E170", "ERJ-170"],
        category: "Regional",
        difficulty: "hard",
        wiki: "Embraer E-Jet family"
    },
    {
        id: "embraer-e175",
        name: "Embraer E175",
        aliases: ["E175", "ERJ-175"],
        category: "Regional",
        difficulty: "medium",
        wiki: "Embraer E-Jet family"
    },
    {
        id: "embraer-e190",
        name: "Embraer E190",
        aliases: ["E190", "ERJ-190"],
        category: "Regional",
        difficulty: "medium",
        wiki: "Embraer E-Jet family"
    },
    {
        id: "embraer-e195",
        name: "Embraer E195",
        aliases: ["E195", "ERJ-195"],
        category: "Regional",
        difficulty: "medium",
        wiki: "Embraer E-Jet family"
    },
    {
        id: "embraer-e2",
        name: "Embraer E195-E2",
        aliases: ["E195-E2", "E195 E2", "E2"],
        category: "Regional",
        difficulty: "hard",
        wiki: "Embraer E-Jet E2 family"
    },
    {
        id: "crj200",
        name: "Bombardier CRJ200",
        aliases: ["CRJ-200", "CRJ 200"],
        category: "Regional",
        difficulty: "hard",
        wiki: "Bombardier CRJ200"
    },
    {
        id: "crj900",
        name: "Bombardier CRJ900",
        aliases: ["CRJ-900", "CRJ 900"],
        category: "Regional",
        difficulty: "medium",
        wiki: "Bombardier CRJ900"
    },

    // MILITARY AND HISTORIC
    {
        id: "sr71",
        name: "Lockheed SR-71 Blackbird",
        aliases: ["SR-71", "SR71", "Blackbird"],
        category: "Military",
        difficulty: "medium",
        wiki: "Lockheed SR-71 Blackbird"
    },
    {
        id: "f14",
        name: "Grumman F-14 Tomcat",
        aliases: ["F-14", "F14", "Tomcat"],
        category: "Military",
        difficulty: "medium",
        wiki: "Grumman F-14 Tomcat"
    },
    {
        id: "f15",
        name: "McDonnell Douglas F-15 Eagle",
        aliases: ["F-15", "F15", "Eagle"],
        category: "Military",
        difficulty: "medium",
        wiki: "McDonnell Douglas F-15 Eagle"
    },
    {
        id: "f16",
        name: "General Dynamics F-16 Fighting Falcon",
        aliases: ["F-16", "F16", "Fighting Falcon", "Viper"],
        category: "Military",
        difficulty: "easy",
        wiki: "General Dynamics F-16 Fighting Falcon"
    },
    {
        id: "f18",
        name: "McDonnell Douglas F/A-18 Hornet",
        aliases: ["F/A-18", "FA18", "F18", "Hornet"],
        category: "Military",
        difficulty: "medium",
        wiki: "McDonnell Douglas F/A-18 Hornet"
    },
    {
        id: "f22",
        name: "Lockheed Martin F-22 Raptor",
        aliases: ["F-22", "F22", "Raptor"],
        category: "Military",
        difficulty: "easy",
        wiki: "Lockheed Martin F-22 Raptor"
    },
    {
        id: "f35",
        name: "Lockheed Martin F-35 Lightning II",
        aliases: ["F-35", "F35", "Lightning II"],
        category: "Military",
        difficulty: "easy",
        wiki: "Lockheed Martin F-35 Lightning II"
    },
    {
        id: "b52",
        name: "Boeing B-52 Stratofortress",
        aliases: ["B-52", "B52", "Stratofortress"],
        category: "Military",
        difficulty: "medium",
        wiki: "Boeing B-52 Stratofortress"
    },
    {
        id: "c130",
        name: "Lockheed C-130 Hercules",
        aliases: ["C-130", "C130", "Hercules"],
        category: "Military",
        difficulty: "easy",
        wiki: "Lockheed C-130 Hercules"
    },
    {
        id: "c17",
        name: "Boeing C-17 Globemaster III",
        aliases: ["C-17", "C17", "Globemaster"],
        category: "Military",
        difficulty: "medium",
        wiki: "Boeing C-17 Globemaster III"
    },
    {
        id: "spitfire",
        name: "Supermarine Spitfire",
        aliases: ["Spitfire"],
        category: "Historic",
        difficulty: "easy",
        wiki: "Supermarine Spitfire"
    },
    {
        id: "hurricane",
        name: "Hawker Hurricane",
        aliases: ["Hurricane"],
        category: "Historic",
        difficulty: "medium",
        wiki: "Hawker Hurricane"
    },
    {
        id: "mustang",
        name: "North American P-51 Mustang",
        aliases: ["P-51", "P51", "Mustang"],
        category: "Historic",
        difficulty: "medium",
        wiki: "North American P-51 Mustang"
    },
    {
        id: "b17",
        name: "Boeing B-17 Flying Fortress",
        aliases: ["B-17", "B17", "Flying Fortress"],
        category: "Historic",
        difficulty: "medium",
        wiki: "Boeing B-17 Flying Fortress"
    },

    // GENERAL AVIATION AND PRIVATE AIRCRAFT
    {
        id: "cessna172",
        name: "Cessna 172 Skyhawk",
        aliases: ["Cessna 172", "C172", "Skyhawk"],
        category: "General Aviation",
        difficulty: "easy",
        wiki: "Cessna 172"
    },
    {
        id: "cessna208",
        name: "Cessna 208 Caravan",
        aliases: ["Cessna Caravan", "C208", "Caravan"],
        category: "General Aviation",
        difficulty: "medium",
        wiki: "Cessna 208 Caravan"
    },
    {
        id: "beechcraft1900",
        name: "Beechcraft 1900",
        aliases: ["B1900", "Beech 1900"],
        category: "Regional",
        difficulty: "hard",
        wiki: "Beechcraft 1900"
    },
    {
        id: "gulfstreamg650",
        name: "Gulfstream G650",
        aliases: ["G650", "Gulfstream 650"],
        category: "Business Jet",
        difficulty: "medium",
        wiki: "Gulfstream G650"
    },
    {
        id: "challenger650",
        name: "Bombardier Challenger 650",
        aliases: ["Challenger 650", "CL650"],
        category: "Business Jet",
        difficulty: "hard",
        wiki: "Bombardier Challenger 600 series"
    },
    {
        id: "falcon7x",
        name: "Dassault Falcon 7X",
        aliases: ["Falcon 7X", "F7X"],
        category: "Business Jet",
        difficulty: "hard",
        wiki: "Dassault Falcon 7X"
    },
    {
        id: "pilatuspc12",
        name: "Pilatus PC-12",
        aliases: ["PC-12", "PC12"],
        category: "General Aviation",
        difficulty: "medium",
        wiki: "Pilatus PC-12"
    },

    // HELICOPTERS
    {
        id: "bell206",
        name: "Bell 206 JetRanger",
        aliases: ["Bell 206", "JetRanger"],
        category: "Helicopter",
        difficulty: "medium",
        wiki: "Bell 206"
    },
    {
        id: "bell407",
        name: "Bell 407",
        aliases: ["B407"],
        category: "Helicopter",
        difficulty: "hard",
        wiki: "Bell 407"
    },
    {
        id: "sikorskyuh60",
        name: "Sikorsky UH-60 Black Hawk",
        aliases: ["UH-60", "UH60", "Black Hawk"],
        category: "Helicopter",
        difficulty: "medium",
        wiki: "Sikorsky UH-60 Black Hawk"
    },
    {
        id: "ch47",
        name: "Boeing CH-47 Chinook",
        aliases: ["CH-47", "CH47", "Chinook"],
        category: "Helicopter",
        difficulty: "medium",
        wiki: "Boeing CH-47 Chinook"
    },
    {
        id: "ah64",
        name: "Boeing AH-64 Apache",
        aliases: ["AH-64", "AH64", "Apache"],
        category: "Helicopter",
        difficulty: "medium",
        wiki: "Boeing AH-64 Apache"
    },

    // INTERNATIONAL AND OTHER AIRCRAFT
    {
        id: "tupolev-tu154",
        name: "Tupolev Tu-154",
        aliases: ["Tu-154", "TU154"],
        category: "Historic",
        difficulty: "hard",
        wiki: "Tupolev Tu-154"
    },
    {
        id: "tupolev-tu134",
        name: "Tupolev Tu-134",
        aliases: ["Tu-134", "TU134"],
        category: "Historic",
        difficulty: "expert",
        wiki: "Tupolev Tu-134"
    },
    {
        id: "ilyushin-il76",
        name: "Ilyushin Il-76",
        aliases: ["Il-76", "IL76"],
        category: "Cargo",
        difficulty: "hard",
        wiki: "Ilyushin Il-76"
    },
    {
        id: "antonov-an124",
        name: "Antonov An-124 Ruslan",
        aliases: ["An-124", "AN124", "Ruslan"],
        category: "Cargo",
        difficulty: "medium",
        wiki: "Antonov An-124 Ruslan"
    },
    {
        id: "antonov-an225",
        name: "Antonov An-225 Mriya",
        aliases: ["An-225", "AN225", "Mriya"],
        category: "Historic",
        difficulty: "easy",
        wiki: "Antonov An-225 Mriya"
    },
    {
        id: "comac-c919",
        name: "COMAC C919",
        aliases: ["C919", "Comac 919"],
        category: "Commercial",
        difficulty: "hard",
        wiki: "Comac C919"
    },
    {
        id: "sukhoi-superjet",
        name: "Sukhoi Superjet 100",
        aliases: ["SSJ100", "Superjet"],
        category: "Regional",
        difficulty: "hard",
        wiki: "Sukhoi Superjet 100"
    },
    {
        id: "mitsubishi-mrj",
        name: "Mitsubishi SpaceJet",
        aliases: ["MRJ", "Mitsubishi Regional Jet"],
        category: "Regional",
        difficulty: "expert",
        wiki: "Mitsubishi SpaceJet"
    },
    {
        id: "dornier228",
        name: "Dornier 228",
        aliases: ["Do 228", "DO228"],
        category: "Regional",
        difficulty: "expert",
        wiki: "Dornier 228"
    }
];

// =====================================================
// AIRCRAFT ANSWER CHECKING
// =====================================================

function normaliseAnswer(value) {
    return value
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
// AIRCRAFT IMAGE LOOKUP
// =====================================================

const imageCache = new Map();

async function getAircraftImage(aircraft) {
    if (imageCache.has(aircraft.id)) {
        return imageCache.get(aircraft.id);
    }

    const headers = {
        "User-Agent": "PlaneSpotterDiscordBot/1.0 (aircraft identification game)"
    };

    // First try the aircraft's Wikipedia article.

    try {
        const url = new URL(WIKIPEDIA_API);

        url.search = new URLSearchParams({
            action: "query",
            format: "json",
            redirects: "1",
            prop: "pageimages",
            piprop: "thumbnail",
            pithumbsize: "1200",
            titles: aircraft.wiki
        }).toString();

        const response = await fetch(url, {
            headers,
            signal: AbortSignal.timeout(10000)
        });

        if (response.ok) {
            const data = await response.json();
            const pages = Object.values(data.query?.pages || {});

            const image = pages.find(
                page => page.thumbnail?.source
            )?.thumbnail?.source;

            if (image) {
                imageCache.set(aircraft.id, image);
                return image;
            }
        }
    } catch (error) {
        console.warn(
            `Wikipedia image lookup failed for ${aircraft.name}:`,
            error.message
        );
    }

    // If Wikipedia has no thumbnail, try Wikimedia Commons.

    try {
        const url = new URL(COMMONS_API);

        url.search = new URLSearchParams({
            action: "query",
            format: "json",
            generator: "search",
            gsrsearch: `filetype:bitmap "${aircraft.name}" aircraft`,
            gsrnamespace: "6",
            gsrlimit: "10",
            prop: "imageinfo",
            iiprop: "url",
            iiurlwidth: "1200"
        }).toString();

        const response = await fetch(url, {
            headers,
            signal: AbortSignal.timeout(10000)
        });

        if (response.ok) {
            const data = await response.json();
            const pages = Object.values(data.query?.pages || {});

            const image = pages.find(
                page => page.imageinfo?.[0]?.thumburl
            )?.imageinfo?.[0]?.thumburl;

            if (image) {
                imageCache.set(aircraft.id, image);
                return image;
            }
        }
    } catch (error) {
        console.warn(
            `Commons image lookup failed for ${aircraft.name}:`,
            error.message
        );
    }

    return null;
}

// =====================================================
// RANDOM AIRCRAFT SELECTION
// =====================================================

function chooseAircraft(guildId, difficulty) {
    let available = AIRCRAFT;

    if (difficulty !== "mixed") {
        available = AIRCRAFT.filter(
            aircraft => aircraft.difficulty === difficulty
        );
    }

    if (available.length === 0) {
        available = AIRCRAFT;
    }

    // Avoid repeating aircraft recently used in this server.

    const cutoff = Date.now() - (90 * 24 * 60 * 60 * 1000);

    const recent = db.prepare(`
        SELECT DISTINCT aircraft_id
        FROM games
        WHERE guild_id = ? AND posted_at > ?
    `).all(guildId, cutoff);

    const recentIds = new Set(
        recent.map(row => row.aircraft_id)
    );

    let fresh = available.filter(
        aircraft => !recentIds.has(aircraft.id)
    );

    if (fresh.length === 0) {
        fresh = available;
    }

    return fresh[
        Math.floor(Math.random() * fresh.length)
    ];
}

// =====================================================
// EMBEDS
// =====================================================

function makeGameEmbed(aircraft, imageUrl, questionNumber) {
    const embed = new EmbedBuilder()
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

    return embed;
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
            await postQuestion(guildId);
        } catch (error) {
            console.error(
                `Could not post question for ${guildId}:`,
                error
            );
        }

        startScheduler(guildId);
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

    const nextPost = settings.last_post_at
        ? settings.last_post_at + interval
        : Date.now() + 3000;

    scheduleNextQuestion(
        guildId,
        Math.max(1000, nextPost - Date.now())
    );
}

// =====================================================
// POSTING A QUESTION
// =====================================================

async function postQuestion(guildId) {
    const settings = getSettings(guildId);

    if (!settings.enabled || !settings.channel_id) {
        return;
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
        return;
    }

    // Close any previous active rounds before posting a new one.

    const previousGames = statements.activeGames.all(guildId);

    for (const previous of previousGames) {
        await revealGame(previous.id);
    }

    // Try several aircraft in case an image cannot be found.

    let aircraft = null;
    let imageUrl = null;

    for (let attempt = 0; attempt < 6; attempt++) {
        const candidate = chooseAircraft(
            guildId,
            settings.difficulty
        );

        if (!candidate) break;

        const image = await getAircraftImage(candidate);

        if (image) {
            aircraft = candidate;
            imageUrl = image;
            break;
        }
    }

    if (!aircraft || !imageUrl) {
        console.warn(
            `No aircraft image could be found for ${guildId}.`
        );
        return;
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

    try {
        const message = await channel.send({
            embeds: [embed],
            components: [row]
        });

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

        statements.updateLastPost.run(now, guildId);

        scheduleReveal(gameId, expiresAt);

        console.log(
            `Posted ${aircraft.name} in ${guildId}`
        );

    } catch (error) {
        console.error("Failed to send aircraft post:", error);
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

    const settings = getSettings(game.guild_id);

    const aircraft = AIRCRAFT.find(
        item => item.id === game.aircraft_id
    );

    if (!aircraft) {
        statements.closeGame.run("revealed", gameId);
        return;
    }

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

    statements.closeGame.run("revealed", gameId);
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
            SUM(correct) AS correct
        FROM attempts
        WHERE guild_id = ? AND user_id = ?
    `).get(guildId, user.id);

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
            `• Accuracy: **${accuracy}%**`
        ].join("\n"))
        .setFooter({
            text: "PlaneSpotter • Player statistics"
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
        .setDescription("View PlaneSpotter commands")

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

            // Record attempts and points in one transaction.

            const recordAttempt = db.transaction(() => {
                statements.insertAttempt.run(
                    gameId,
                    game.guild_id,
                    interaction.user.id,
                    submittedAnswer,
                    correct ? 1 : 0,
                    Date.now()
                );

                if (correct) {
                    statements.addScore.run(
                        game.guild_id,
                        interaction.user.id,
                        Date.now()
                    );
                }
            });

            try {
                recordAttempt();
            } catch (error) {
                if (error.code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
                    return interaction.reply({
                        content: "You have already submitted an answer.",
                        ephemeral: true
                    });
                }

                throw error;
            }

            if (correct) {
                return interaction.reply({
                    content: [
                        "Correct! You identified the aircraft.",
                        "",
                        "• **1 point** has been added to your server leaderboard.",
                        "• Use `/leaderboard` to check your position.",
                        "• Use `/profile` to view your statistics."
                    ].join("\n"),
                    ephemeral: true
                });
            }

            return interaction.reply({
                content: [
                    "That answer isn't correct.",
                    "",
                    "• Your submission has been recorded.",
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

