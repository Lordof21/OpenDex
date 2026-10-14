// Dil seçici: arama yerel ada, arayüz dilindeki ada ve koda bakar; harf boyutu ve aksan farkı yok sayılır.
import { describe, expect, it } from 'vitest';

import { filterLanguages, languageLabel } from '../src/taskbar/LanguagePicker.jsx';

const languages = [
  { code: 'tr', name: 'Türkçe', label: 'Turkish' },
  { code: 'es', name: 'Español', label: 'Spanish' },
  { code: 'zh-CN', name: '简体中文', label: 'Chinese (China)' },
  { code: 'ku', name: 'Kurdî (Kurmancî)', label: 'Kurdish' },
];

describe('dil seçici araması', () => {
  const codes = (query) => filterLanguages(languages, query).map((l) => l.code);

  it('boş arama hepsini döndürür', () => {
    expect(codes('')).toEqual(['tr', 'es', 'zh-CN', 'ku']);
    expect(codes('   ')).toEqual(['tr', 'es', 'zh-CN', 'ku']);
  });

  it('yerel ada aksan ve harf boyutundan bağımsız bakar', () => {
    expect(codes('turkce')).toEqual(['tr']);
    expect(codes('ESPAÑOL')).toEqual(['es']);
    expect(codes('espanol')).toEqual(['es']);
    expect(codes('kurmanci')).toEqual(['ku']);
  });

  it('arayüz dilindeki ada ve koda da bakar', () => {
    expect(codes('chinese')).toEqual(['zh-CN']);
    expect(codes('zh-cn')).toEqual(['zh-CN']);
    expect(codes('简体')).toEqual(['zh-CN']);
  });

  it('eşleşme yoksa boş liste döner', () => {
    expect(codes('klingon')).toEqual([]);
  });

  it('arayüz dilindeki ad Intl.DisplayNames ile gelir; desteklenmeyen kodda boş', () => {
    expect(languageLabel('es', 'en-US')).toBe('Spanish');
    expect(languageLabel('ja', 'tr-TR')).toBe('Japonca');
    expect(languageLabel('!!', 'en-US')).toBe('');
  });
});
