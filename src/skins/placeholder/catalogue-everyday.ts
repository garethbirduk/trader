import type { InsertItemKindInput } from "../../engine/stock/items-repo.js";

/**
 * The mundane catalogue — generic stock the world can spawn pools of any
 * day of the week. None of these are flagged dodgy by default; they're
 * the everyday "stuff fell off a lorry" inventory. Spawn weights are
 * relative; the median item sits at 10.
 *
 * `size` is per-unit: a single unit's physical bulk, not the whole lot.
 *   • small — pocket-sized; can be exchanged person-to-person.
 *   • mid   — boot-sized; needs a car to move.
 *   • large — needs a van or truck.
 */
export const EVERYDAY_ITEMS: readonly InsertItemKindInput[] = [
  // Electrical
  { code: "vacuums",         displayName: "Vacuum cleaners",   category: "electrical", baseValue: 30, spawnWeight: 14, size: "mid",   targetCustomers: ["families", "tradesmen"] },
  { code: "microwaves",      displayName: "Microwaves",        category: "electrical", baseValue: 50, spawnWeight: 12, size: "mid",   targetCustomers: ["families", "businesses"] },
  { code: "kettles",         displayName: "Kettles",           category: "electrical", baseValue: 12, spawnWeight: 14, size: "small", targetCustomers: ["families"] },
  { code: "toasters",        displayName: "Toasters",          category: "electrical", baseValue: 14, spawnWeight: 12, size: "small", targetCustomers: ["families"] },
  { code: "irons",           displayName: "Steam irons",       category: "electrical", baseValue: 18, spawnWeight: 11, size: "small", targetCustomers: ["families"] },
  { code: "hi-fis",          displayName: "Hi-fi systems",     category: "electrical", baseValue: 80, spawnWeight: 8,  size: "mid",   targetCustomers: ["yuppies", "music-fans"] },
  { code: "fans",            displayName: "Desk fans",         category: "electrical", baseValue: 16, spawnWeight: 10, size: "small", targetCustomers: ["businesses", "families"] },
  { code: "electric-heaters", displayName: "Electric heaters", category: "electrical", baseValue: 28, spawnWeight: 10, size: "mid",   targetCustomers: ["families", "tradesmen"] },
  { code: "blenders",        displayName: "Blenders",          category: "electrical", baseValue: 22, spawnWeight: 9,  size: "small", targetCustomers: ["families"] },
  { code: "alarm-clocks",    displayName: "Alarm clocks",      category: "electrical", baseValue: 8,  spawnWeight: 12, size: "small", targetCustomers: ["families", "businesses"] },

  // Furniture
  { code: "tables",          displayName: "Tables",            category: "furniture",  baseValue: 20, spawnWeight: 12, size: "large", targetCustomers: ["families", "businesses"] },
  { code: "chairs",          displayName: "Chairs",            category: "furniture",  baseValue: 12, spawnWeight: 14, size: "mid",   targetCustomers: ["families", "businesses"] },
  { code: "sofas",           displayName: "Sofas",             category: "furniture",  baseValue: 90, spawnWeight: 6,  size: "large", targetCustomers: ["families"] },
  { code: "wardrobes",       displayName: "Wardrobes",         category: "furniture",  baseValue: 70, spawnWeight: 6,  size: "large", targetCustomers: ["families"] },
  { code: "bookcases",       displayName: "Bookcases",         category: "furniture",  baseValue: 35, spawnWeight: 9,  size: "large", targetCustomers: ["families", "businesses"] },
  { code: "desks",           displayName: "Desks",             category: "furniture",  baseValue: 55, spawnWeight: 9,  size: "large", targetCustomers: ["businesses", "yuppies"] },
  { code: "lamps",           displayName: "Table lamps",       category: "furniture",  baseValue: 14, spawnWeight: 12, size: "small", targetCustomers: ["families", "yuppies"] },

  // Tools / DIY
  { code: "paint-tins",      displayName: "Tins of paint",     category: "tools",      baseValue: 12, spawnWeight: 14, size: "small", targetCustomers: ["tradesmen", "families"] },
  { code: "drills",          displayName: "Power drills",      category: "tools",      baseValue: 35, spawnWeight: 10, size: "small", targetCustomers: ["tradesmen"] },
  { code: "hammers",         displayName: "Claw hammers",      category: "tools",      baseValue: 6,  spawnWeight: 12, size: "small", targetCustomers: ["tradesmen", "families"] },
  { code: "screwdriver-sets", displayName: "Screwdriver sets", category: "tools",      baseValue: 10, spawnWeight: 12, size: "small", targetCustomers: ["tradesmen", "families"] },
  { code: "ladders",         displayName: "Aluminium ladders", category: "tools",      baseValue: 45, spawnWeight: 8,  size: "large", targetCustomers: ["tradesmen"] },
  { code: "ropes",           displayName: "Coiled rope",       category: "tools",      baseValue: 8,  spawnWeight: 10, size: "small", targetCustomers: ["tradesmen"] },
  { code: "wallpaper",       displayName: "Rolls of wallpaper", category: "decor",     baseValue: 8,  spawnWeight: 10, size: "mid",   targetCustomers: ["families", "tradesmen"] },

  // Clothing
  { code: "shirts",          displayName: "Mens' shirts",      category: "clothing",   baseValue: 14, spawnWeight: 12, size: "small", targetCustomers: ["yuppies", "market-punters"] },
  { code: "jeans",           displayName: "Denim jeans",       category: "clothing",   baseValue: 18, spawnWeight: 12, size: "small", targetCustomers: ["yuppies", "market-punters"] },
  { code: "jackets",         displayName: "Leather jackets",   category: "clothing",   baseValue: 60, spawnWeight: 8,  size: "small", targetCustomers: ["yuppies"] },
  { code: "coats",           displayName: "Winter coats",      category: "clothing",   baseValue: 40, spawnWeight: 8,  size: "small", targetCustomers: ["families", "market-punters"] },
  { code: "ties",            displayName: "Silk ties",         category: "clothing",   baseValue: 8,  spawnWeight: 10, size: "small", targetCustomers: ["yuppies", "businesses"] },
  { code: "hats",            displayName: "Hats",              category: "clothing",   baseValue: 10, spawnWeight: 9,  size: "small", targetCustomers: ["market-punters"] },

  // Toys
  { code: "lego-sets",       displayName: "Lego sets",         category: "toys",       baseValue: 15, spawnWeight: 10, size: "small", targetCustomers: ["families"] },
  { code: "board-games",     displayName: "Board games",       category: "toys",       baseValue: 12, spawnWeight: 10, size: "small", targetCustomers: ["families"] },
  { code: "action-figures",  displayName: "Action figures",    category: "toys",       baseValue: 6,  spawnWeight: 11, size: "small", targetCustomers: ["families"] },
  { code: "dolls",           displayName: "Dolls",             category: "toys",       baseValue: 14, spawnWeight: 9,  size: "small", targetCustomers: ["families"] },
  { code: "puzzles",         displayName: "Jigsaw puzzles",    category: "toys",       baseValue: 8,  spawnWeight: 11, size: "small", targetCustomers: ["families", "old-dears"] },

  // Decor / Novelty
  { code: "vases",           displayName: "Ceramic vases",     category: "decor",      baseValue: 14, spawnWeight: 9,  size: "small", targetCustomers: ["old-dears", "families"] },
  { code: "ornaments",       displayName: "China ornaments",   category: "decor",      baseValue: 10, spawnWeight: 11, size: "small", targetCustomers: ["old-dears"] },
  { code: "mirrors",         displayName: "Wall mirrors",      category: "decor",      baseValue: 22, spawnWeight: 10, size: "mid",   targetCustomers: ["families", "yuppies"] },
  { code: "frames",          displayName: "Picture frames",    category: "decor",      baseValue: 6,  spawnWeight: 12, size: "small", targetCustomers: ["families"] },
  { code: "candles",         displayName: "Boxes of candles",  category: "decor",      baseValue: 4,  spawnWeight: 13, size: "small", targetCustomers: ["families", "old-dears"] },

  // Luggage / accessories
  { code: "briefcases",      displayName: "Briefcases",        category: "luggage",    baseValue: 25, spawnWeight: 9,  size: "small", targetCustomers: ["yuppies", "businesses"] },
  { code: "suitcases",       displayName: "Suitcases",         category: "luggage",    baseValue: 30, spawnWeight: 10, size: "mid",   targetCustomers: ["families", "yuppies"] },
  { code: "backpacks",       displayName: "Backpacks",         category: "luggage",    baseValue: 18, spawnWeight: 10, size: "small", targetCustomers: ["families"] },

  // Food (perishable / consumable feel — flagged later milestone)
  { code: "tinned-goods",    displayName: "Tinned goods",      category: "food",       baseValue: 3,  spawnWeight: 13, size: "small", targetCustomers: ["families", "market-punters"] },
  { code: "biscuits",        displayName: "Tins of biscuits",  category: "food",       baseValue: 6,  spawnWeight: 12, size: "small", targetCustomers: ["families", "old-dears"] },
  { code: "tea-bags",        displayName: "Boxes of tea",      category: "food",       baseValue: 5,  spawnWeight: 13, size: "small", targetCustomers: ["families", "old-dears"] },
  { code: "coffee",          displayName: "Coffee jars",       category: "food",       baseValue: 8,  spawnWeight: 11, size: "small", targetCustomers: ["yuppies", "families"] },

  // Safety / specialist
  { code: "crash-helmets",   displayName: "Crash helmets",     category: "safety",     baseValue: 40, spawnWeight: 7,  size: "small", targetCustomers: ["specialists"] },
  { code: "smoke-detectors", displayName: "Smoke detectors",   category: "safety",     baseValue: 18, spawnWeight: 9,  size: "small", targetCustomers: ["families", "businesses"] },
];
