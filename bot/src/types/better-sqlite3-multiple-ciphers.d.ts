// The package ships types its "exports" field hides; it has the API of
// better-sqlite3 (plus cipher pragmas), so it takes those types.
declare module 'better-sqlite3-multiple-ciphers' {
  import Database = require('better-sqlite3');
  export = Database;
}
