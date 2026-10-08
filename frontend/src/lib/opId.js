// Akış numarası: bir kullanıcı eylemini (tık → istek → olay) tarayıcı ve backend loglarında eşleştirir.
// api.js isteğe `X-Op-Id` olarak ekler; backend aynı numarayı her log satırına `[op:xxxxxx]` diye basar.
export function newOpId() {
  return Math.random().toString(36).slice(2, 8).padEnd(6, '0');
}
