// Bildirim paneli boyu: HER durumda sabit ve tam — görev çubuğunun 16 px üstünden başlar, ekranın TAM 16 px altına kadar uzanır
// (takvim küçükken de açıkken de). Liste, başlık ile takvim arasında kalan yeri doldurur; kartlar kendi boyunda kalır (kartı
// uzatıp kısaltan bir oturtma YOK — saha geri bildirimi 2026-10-16: "gereksiz büyük oldu").
export const TASKBAR_HEIGHT_PX = 50;
export const PANEL_GAP_PX = 16;           // panelin görev çubuğundan uzaklığı (ClockCalendar `bottom-[calc(100%+16px)]`)
export const PANEL_TOP_MARGIN_PX = 16;    // ekranın üstünden bırakılan boşluk
export const PANEL_RESERVED_PX = TASKBAR_HEIGHT_PX + PANEL_GAP_PX + PANEL_TOP_MARGIN_PX; // 82
export const PANEL_HEIGHT = `calc(100vh - ${PANEL_RESERVED_PX}px)`;
