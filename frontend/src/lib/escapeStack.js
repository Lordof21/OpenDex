// "Esc en üstteki şeyi kapatır": iç içe katmanlar (hızlı ayar paneli > sürüklenen kaydırıcı …) Esc'yi
// LIFO sırasıyla tüketir. Tek bir pencere-yakalama (capture) dinleyicisi vardır; en son eklenen işleyici çalışır
// ve olay başka dinleyicilere (ör. "tam ekrandan çık", "paneli kapat") ULAŞMAZ.
//
//   const remove = pushEscapeHandler(() => close());   // katman açılınca
//   remove();                                          // katman kapanınca
const stack = [];
let installed = false;

function onKeyDown(event) {
  if (event.key !== 'Escape' || stack.length === 0) return;
  event.stopPropagation();
  event.preventDefault();
  stack[stack.length - 1].handler(event);
}

export function pushEscapeHandler(handler) {
  const entry = { handler };
  stack.push(entry);
  if (!installed) {
    window.addEventListener('keydown', onKeyDown, true);
    installed = true;
  }
  return () => {
    const index = stack.indexOf(entry);
    if (index >= 0) stack.splice(index, 1);
    if (stack.length === 0 && installed) {
      window.removeEventListener('keydown', onKeyDown, true);
      installed = false;
    }
  };
}

/** Yalnız testler için: kayıtlı işleyici sayısı. */
export function escapeStackDepth() {
  return stack.length;
}
