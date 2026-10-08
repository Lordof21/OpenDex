// Gerçek Tailwind derlemesini çalıştırıp çıktıyı denetler — vitest/jsdom gerçek CSS üretimini hiç görmediği için
// (DOM'da sınıf adı var ama `display:none` kalabiliyor), bileşen testleri bu sınıftaki hatayı YAKALAYAMAZ.
//
// Kök neden sınıfı (Görev: taskbar'da uygulama çekmecesi + medya kartı kayboldu): Tailwind'in içerik tarayıcısı JS/JSX
// dosyalarını AST olarak değil DÜZ METİN olarak tarar — bir YORUM içinde bile `max-[…]:hidden` gibi köşeli parantezli,
// birimsiz (ör. üç nokta) bir "örnek" yazmak, o değerin "birimini" (boş/özel karakter) PROJE ÇAPINDA paylaşılan bir
// önbelleğe ekler; bu önbellek tutarsız hâle gelince Tailwind TÜM min-*/max-* keyfi değer varyantlarını (ör. gerçek
// `min-[430px]:flex`) SESSİZCE üretmeyi durdurur (bkz. tailwindcss/lib/corePlugins.js screenVariants, "mixed units").
import { readFileSync } from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ROOT = process.cwd();

afterEach(() => vi.restoreAllMocks());

describe('Tailwind derlemesi: min-*/max-* keyfi değişkenleri sessizce devre dışı kalmaz', () => {
  it('index.css + tailwind.config.js tüm projeyi tarayınca "mixed units" uyarısı vermez ve bilinen min-[Npx]/max-[Npx] sınıfları üretilir', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const input = readFileSync(path.join(ROOT, 'src/index.css'), 'utf8');

    const result = await postcss([tailwindcss({ config: path.join(ROOT, 'tailwind.config.js') })])
      .process(input, { from: path.join(ROOT, 'src/index.css') });
    const css = result.css;

    const warnedMixedUnits = warnSpy.mock.calls.some((args) =>
      args.some((a) => typeof a === 'string' && a.includes('mixed units')));
    expect(warnedMixedUnits).toBe(false);

    // Taskbar.jsx + MediaWidget.jsx'in görünürlük anahtarı olarak kullandığı GERÇEK eşikler: bu kurallar yoksa
    // (yukarıdaki uyarı sessizce yutulmuş olsa bile) uygulama çekmecesi ve medya kartı taskbar'da hiç görünmez.
    expect(css).toContain('min-width: 430px');
    expect(css).toContain('max-width: 599px');
    expect(css).toContain('max-width: 899px');
    expect(css).toContain('max-width: 480px');
  }, 20000);
});
