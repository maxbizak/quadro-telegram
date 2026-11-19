// First of all (imported before teleproto): cifrante, teleproto's cipher, would try to load an optional native module of its own
// from the part's folder; a part has none (the Catalog takes no native code) — its pure JavaScript is used from the start.
try {
  process.env.CIFRANTE_NATIVE = '0';
} catch {
  // a frozen environment: cifrante then just fails to find the module and falls back the same way
}
