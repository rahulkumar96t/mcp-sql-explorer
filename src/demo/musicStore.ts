import Database from 'better-sqlite3';

/**
 * Builds a small, deterministic music-store database for demos and tests. Everything is
 * generated from a seeded PRNG, so the same seed always produces the same file contents.
 * All names are synthetic word combinations; none refer to real people or bands.
 */
export interface MusicStoreOptions {
  seed?: number;
  artists?: number;
  customers?: number;
  invoices?: number;
}

export type MusicStoreSummary = Record<
  'genres' | 'artists' | 'albums' | 'tracks' | 'customers' | 'invoices' | 'invoice_lines',
  number
>;

const SCHEMA = `
CREATE TABLE genres (
  genre_id   INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE
);
CREATE TABLE artists (
  artist_id   INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  country     TEXT NOT NULL,
  formed_year INTEGER
);
CREATE TABLE albums (
  album_id     INTEGER PRIMARY KEY,
  artist_id    INTEGER NOT NULL REFERENCES artists (artist_id),
  genre_id     INTEGER NOT NULL REFERENCES genres (genre_id),
  title        TEXT NOT NULL,
  release_year INTEGER NOT NULL
);
CREATE TABLE tracks (
  track_id         INTEGER PRIMARY KEY,
  album_id         INTEGER NOT NULL REFERENCES albums (album_id) ON DELETE CASCADE,
  track_number     INTEGER NOT NULL,
  title            TEXT NOT NULL,
  composer         TEXT,
  duration_ms      INTEGER NOT NULL CHECK (duration_ms > 0),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  UNIQUE (album_id, track_number)
);
CREATE TABLE customers (
  customer_id  INTEGER PRIMARY KEY,
  first_name   TEXT NOT NULL,
  last_name    TEXT NOT NULL,
  city         TEXT NOT NULL,
  country      TEXT NOT NULL,
  signed_up_on TEXT NOT NULL
);
CREATE TABLE invoices (
  invoice_id      INTEGER PRIMARY KEY,
  customer_id     INTEGER NOT NULL REFERENCES customers (customer_id),
  invoiced_at     TEXT NOT NULL,
  billing_country TEXT NOT NULL,
  total_cents     INTEGER NOT NULL
);
CREATE TABLE invoice_lines (
  invoice_line_id  INTEGER PRIMARY KEY,
  invoice_id       INTEGER NOT NULL REFERENCES invoices (invoice_id) ON DELETE CASCADE,
  track_id         INTEGER NOT NULL REFERENCES tracks (track_id),
  unit_price_cents INTEGER NOT NULL,
  quantity         INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0)
);
CREATE INDEX idx_albums_artist ON albums (artist_id);
CREATE INDEX idx_tracks_album ON tracks (album_id);
CREATE INDEX idx_invoices_customer_date ON invoices (customer_id, invoiced_at);
CREATE INDEX idx_invoice_lines_invoice ON invoice_lines (invoice_id);
CREATE INDEX idx_invoice_lines_track ON invoice_lines (track_id);
CREATE VIEW sales_by_genre AS
  SELECT g.name AS genre,
         count(*) AS lines_sold,
         round(sum(l.unit_price_cents * l.quantity) / 100.0, 2) AS revenue
    FROM invoice_lines AS l
    JOIN tracks AS t ON t.track_id = l.track_id
    JOIN albums AS a ON a.album_id = t.album_id
    JOIN genres AS g ON g.genre_id = a.genre_id
   GROUP BY g.name;
`;

const GENRES = ['Ambient', 'Blues', 'Classical', 'Electronic', 'Folk', 'Hip-Hop', 'Jazz', 'Metal', 'Pop', 'Rock'];
const ADJECTIVES = [
  'Amber', 'Broken', 'Crimson', 'Distant', 'Electric', 'Fading', 'Golden', 'Hollow', 'Iron', 'Lunar',
  'Midnight', 'Neon', 'Paper', 'Quiet', 'Restless', 'Silver', 'Static', 'Velvet', 'Wandering', 'Wild',
];
const NOUNS = [
  'Anchors', 'Birds', 'Cartographers', 'Comets', 'Engines', 'Foxes', 'Gardens', 'Harbours', 'Lanterns', 'Machines',
  'Mirrors', 'Owls', 'Pilots', 'Rivers', 'Satellites', 'Signals', 'Tides', 'Wolves', 'Echoes', 'Orchards',
];
const TITLE_WORDS = [
  'after', 'blue', 'city', 'dawn', 'echo', 'fire', 'glass', 'home', 'island', 'june', 'kite', 'light', 'morning',
  'night', 'ocean', 'paper', 'quiet', 'rain', 'summer', 'train', 'under', 'violet', 'winter', 'yellow', 'zero',
];
const FIRST_NAMES = [
  'Alex', 'Bo', 'Casey', 'Dana', 'Eli', 'Frankie', 'Gale', 'Harper', 'Indy', 'Jules', 'Kai', 'Lee', 'Morgan',
  'Noa', 'Oakley', 'Parker', 'Quinn', 'Remy', 'Sam', 'Tate', 'Uma', 'Vic', 'Wren', 'Yael', 'Zuri',
];
const LAST_NAMES = [
  'Abbott', 'Brooks', 'Castillo', 'Dubois', 'Eriksen', 'Fischer', 'Gallo', 'Haas', 'Ivanova', 'Jansen', 'Kowalski',
  'Lindqvist', 'Moreau', 'Novak', 'Okafor', 'Petrov', 'Quint', 'Rossi', 'Sato', 'Torres', 'Ueda', 'Varga', 'Weber',
];
const CITIES: Record<string, string[]> = {
  Austria: ['Vienna', 'Graz'],
  Brazil: ['Sao Paulo', 'Recife'],
  Canada: ['Toronto', 'Montreal', 'Vancouver'],
  France: ['Paris', 'Lyon'],
  Germany: ['Berlin', 'Hamburg', 'Munich'],
  India: ['Bengaluru', 'Kochi', 'Pune'],
  Japan: ['Tokyo', 'Osaka'],
  Sweden: ['Stockholm', 'Gothenburg'],
  Switzerland: ['Zurich', 'Geneva', 'Basel'],
  'United Kingdom': ['London', 'Manchester'],
  'United States': ['Austin', 'Chicago', 'New York', 'Seattle'],
};
const COUNTRIES = Object.keys(CITIES);

/** mulberry32: tiny, fast, good enough for synthetic data, and reproducible across platforms. */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildMusicStore(path: string, options: MusicStoreOptions = {}): MusicStoreSummary {
  const random = createRandom(options.seed ?? 20_26);
  const int = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  // Squaring skews choices towards the front of a list: a few best sellers, a long tail.
  const pickSkewed = <T>(items: readonly T[]): T => items[Math.floor(random() ** 2 * items.length)] as T;
  const titleCase = (word: string) => word[0]?.toUpperCase() + word.slice(1);
  const title = (words: number) =>
    Array.from({ length: words }, () => pick(TITLE_WORDS))
      .map(titleCase)
      .join(' ');

  const db = new Database(path);
  db.pragma('journal_mode = DELETE');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  const insert = {
    genre: db.prepare('INSERT INTO genres (genre_id, name) VALUES (?, ?)'),
    artist: db.prepare('INSERT INTO artists (artist_id, name, country, formed_year) VALUES (?, ?, ?, ?)'),
    album: db.prepare('INSERT INTO albums (album_id, artist_id, genre_id, title, release_year) VALUES (?, ?, ?, ?, ?)'),
    track: db.prepare(
      'INSERT INTO tracks (track_id, album_id, track_number, title, composer, duration_ms, unit_price_cents) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ),
    customer: db.prepare(
      'INSERT INTO customers (customer_id, first_name, last_name, city, country, signed_up_on) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    invoice: db.prepare(
      'INSERT INTO invoices (invoice_id, customer_id, invoiced_at, billing_country, total_cents) VALUES (?, ?, ?, ?, ?)',
    ),
    line: db.prepare(
      'INSERT INTO invoice_lines (invoice_id, track_id, unit_price_cents, quantity) VALUES (?, ?, ?, ?)',
    ),
  };

  const summary: MusicStoreSummary = {
    genres: 0,
    artists: 0,
    albums: 0,
    tracks: 0,
    customers: 0,
    invoices: 0,
    invoice_lines: 0,
  };

  db.transaction(() => {
    GENRES.forEach((name, index) => insert.genre.run(index + 1, name));
    summary.genres = GENRES.length;

    const artistNames = new Set<string>();
    while (artistNames.size < (options.artists ?? 60)) {
      artistNames.add(`The ${pick(ADJECTIVES)} ${pick(NOUNS)}`);
    }

    const tracks: Array<{ id: number; price: number }> = [];
    let artistId = 0;
    let albumId = 0;
    for (const name of artistNames) {
      artistId += 1;
      const formed = random() < 0.1 ? null : int(1965, 2020);
      insert.artist.run(artistId, name, pick(COUNTRIES), formed);
      const genreId = int(1, GENRES.length);
      for (let a = 0, albums = int(1, 5); a < albums; a += 1) {
        albumId += 1;
        const released = Math.max(formed ?? 1965, 1965) + int(0, 8) + a * int(1, 4);
        insert.album.run(albumId, artistId, random() < 0.8 ? genreId : int(1, GENRES.length), title(int(1, 3)), Math.min(released, 2025));
        const composer = random() < 0.7 ? `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}` : null;
        for (let n = 1, count = int(6, 14); n <= count; n += 1) {
          const id = tracks.length + 1;
          const price = random() < 0.85 ? 99 : 129;
          const duration = int(95_000, 420_000) + (random() < 0.02 ? 1_200_000 : 0);
          insert.track.run(id, albumId, n, title(int(1, 4)), random() < 0.9 ? composer : null, duration, price);
          tracks.push({ id, price });
        }
      }
    }
    summary.artists = artistId;
    summary.albums = albumId;
    summary.tracks = tracks.length;

    const customers: Array<{ id: number; country: string; since: number }> = [];
    const start = Date.UTC(2022, 0, 1);
    const end = Date.UTC(2025, 11, 31);
    for (let id = 1; id <= (options.customers ?? 400); id += 1) {
      const country = pickSkewed(COUNTRIES);
      const since = start + Math.floor(random() * (end - start) * 0.8);
      insert.customer.run(id, pick(FIRST_NAMES), pick(LAST_NAMES), pick(CITIES[country] ?? ['Unknown']), country, isoDate(since));
      customers.push({ id, country, since });
    }
    summary.customers = customers.length;

    // Popular tracks are drawn more often; shuffle once so popularity is not tied to track_id.
    const catalogue = shuffle(tracks, random);
    for (let id = 1; id <= (options.invoices ?? 3000); id += 1) {
      const customer = pickSkewed(customers);
      const invoicedAt = customer.since + Math.floor(random() * (end - customer.since));
      const lines = Array.from({ length: int(1, 8) }, () => ({
        track: pickSkewed(catalogue),
        quantity: random() < 0.95 ? 1 : 2,
      }));
      const total = lines.reduce((sum, line) => sum + line.track.price * line.quantity, 0);
      insert.invoice.run(id, customer.id, isoDateTime(invoicedAt), customer.country, total);
      for (const line of lines) {
        insert.line.run(id, line.track.id, line.track.price, line.quantity);
      }
      summary.invoices += 1;
      summary.invoice_lines += lines.length;
    }
  })();

  db.close();
  return summary;
}

/** Fisher-Yates shuffle driven by the seeded PRNG. */
function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy;
}

function isoDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

function isoDateTime(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 19).replace('T', ' ');
}
