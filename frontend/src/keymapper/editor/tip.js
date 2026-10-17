// Uygulamanın kendi ipucu sistemi (index.css `[data-tooltip]`): düz `title` yerine tema renginde, bekleme animasyonlu ipucu.
//   position: 'top' (varsayılan, yukarıda) | 'bottom' | 'right'   — kenara yakın düğmede içeri doğru açılan yönü seçin
//   align:    'end' → ipucu düğmenin sağ kenarına hizalanır (sağ kenardaki düğmede dışarı taşmasın)
// Konumlu (absolute) bir öğeye uygulanıyorsa öğe `!absolute` almalıdır: `[data-tooltip]` kendi `position: relative`ını getirir.
export function tip(text, position = 'top', align) {
  if (!text) return {};
  const props = { 'data-tooltip': text };
  if (position !== 'top') props['data-tooltip-position'] = position;
  if (align) props['data-tooltip-align'] = align;
  return props;
}
