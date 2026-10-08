"""Önizleme doğrulaması için küçük gerçek dosyalar üretir (yalnız standart kütüphane): PDF, DOCX, XLSX, PPTX ve bir WAV (ses).
Kullanım: python3 uret.py <hedef klasör>. Üretim kodunun parçası değildir; run.sh çağırır ve çıkışta siler."""
import math
import struct
import sys
import wave
import zipfile
from pathlib import Path

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
OUT.mkdir(parents=True, exist_ok=True)


def pdf() -> bytes:
    """İki sayfalık, Helvetica ile yazılmış (gömülü yazı tipi yok) geçerli bir PDF."""
    def page(title: str, lines: list[str]) -> bytes:
        text = [b"BT /F1 24 Tf 60 740 Td (" + title.encode() + b") Tj ET", b"0.2 0.4 0.8 rg 60 700 200 6 re f"]
        y = 660
        for line in lines:
            text.append(b"BT /F1 13 Tf 60 %d Td (" % y + line.encode() + b") Tj ET")
            y -= 22
        return b"\n".join(text)

    contents = [page("Yillik Rapor 2024", ["Bu bir onizleme dogrulama belgesidir.", "Sayfa bellekte cizilir, diske yazilmaz.", "Salt okunur."]),
                page("Ikinci Sayfa", ["Grafikler ve tablolar burada olurdu.", "Satir uc.", "Satir dort."])]
    objs: list[bytes] = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>"]
    objs.append(b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 7 0 R >> >> >>")
    objs.append(b"<< /Length %d >>\nstream\n" % len(contents[0]) + contents[0] + b"\nendstream")
    objs.append(b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>")
    objs.append(b"<< /Length %d >>\nstream\n" % len(contents[1]) + contents[1] + b"\nendstream")
    objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objs, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    for off in offsets:
        out += b"%010d 00000 n \n" % off
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
    return bytes(out)


def build(path: Path, files: dict[str, str]) -> None:
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, text in files.items():
            z.writestr(name, text)


XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
REL = "http://schemas.openxmlformats.org/package/2006/relationships"
CT = "http://schemas.openxmlformats.org/package/2006/content-types"
OD = "http://schemas.openxmlformats.org/officeDocument/2006"


def docx() -> None:
    def p(text, style=None, bold=False, italic=False):
        ppr = f'<w:pPr><w:pStyle w:val="{style}"/></w:pPr>' if style else ""
        rpr = ("<w:b/>" if bold else "") + ("<w:i/>" if italic else "")
        return f'<w:p>{ppr}<w:r>{"<w:rPr>" + rpr + "</w:rPr>" if rpr else ""}<w:t xml:space="preserve">{text}</w:t></w:r></w:p>'

    cell = lambda t: f"<w:tc><w:p><w:r><w:t>{t}</w:t></w:r></w:p></w:tc>"
    table = "<w:tbl>" + "".join("<w:tr>" + "".join(cell(c) for c in row) + "</w:tr>" for row in
                                (("Kalem", "Q1", "Q2"), ("Gelir", "120", "145"), ("Gider", "80", "92"))) + "</w:tbl>"
    body = (p("Yıllık Rapor", "Heading1") + p("Bu belge DOCX önizlemesini doğrulamak için üretildi. ") +
            p("Kalın ve eğik metin ", bold=True) + p("Türkçe karakterler: ığüşöç İĞÜŞÖÇ", italic=True) + p("Özet tablo", "Heading2") + table +
            p("Belge salt okunur gösterilir; düzenlemek için uygulamasında açın."))
    build(OUT / "yillik-rapor.docx", {
        "[Content_Types].xml": f'{XML}<Types xmlns="{CT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
        "_rels/.rels": f'{XML}<Relationships xmlns="{REL}"><Relationship Id="rId1" Type="{OD}/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        "word/_rels/document.xml.rels": f'{XML}<Relationships xmlns="{REL}"><Relationship Id="rId1" Type="{OD}/relationships/styles" Target="styles.xml"/></Relationships>',
        "word/styles.xml": f'{XML}<w:styles xmlns:w="{W}"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style></w:styles>',
        "word/document.xml": f'{XML}<w:document xmlns:w="{W}"><w:body>{body}</w:body></w:document>',
    })


def xlsx() -> None:
    strings = ["Ürün", "Adet", "Fiyat", "Kalem", "Defter", "Kalem seti", "Çanta"]
    ss = "".join(f"<si><t>{s}</t></si>" for s in strings)
    rows = [[("s", 0), ("s", 1), ("s", 2)], [("s", 4), ("n", 12), ("n", 45.5)], [("s", 5), ("n", 30), ("n", 12.25)], [("s", 6), ("n", 4), ("n", 310)]]
    cols = "ABC"
    sheet_rows = "".join(f'<row r="{r}">' + "".join(f'<c r="{cols[c]}{r}"' + (' t="s"' if t == "s" else "") + f"><v>{v}</v></c>" for c, (t, v) in enumerate(row)) + "</row>"
                         for r, row in enumerate(rows, 1))
    sheet = f'{XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>{sheet_rows}</sheetData></worksheet>'
    build(OUT / "butce.xlsx", {
        "[Content_Types].xml": f'{XML}<Types xmlns="{CT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>',
        "_rels/.rels": f'{XML}<Relationships xmlns="{REL}"><Relationship Id="rId1" Type="{OD}/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        "xl/workbook.xml": f'{XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="{OD}/relationships"><sheets><sheet name="Satışlar" sheetId="1" r:id="rId1"/><sheet name="Notlar" sheetId="2" r:id="rId2"/></sheets></workbook>',
        "xl/_rels/workbook.xml.rels": f'{XML}<Relationships xmlns="{REL}"><Relationship Id="rId1" Type="{OD}/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="{OD}/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="{OD}/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>',
        "xl/sharedStrings.xml": f'{XML}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="{len(strings)}" uniqueCount="{len(strings)}">{ss}</sst>',
        "xl/worksheets/sheet1.xml": sheet,
        "xl/worksheets/sheet2.xml": f'{XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>3</v></c></row></sheetData></worksheet>',
    })


def pptx() -> None:
    ns = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
    slide = lambda *t: f'{XML}<p:sld {ns}><p:cSld><p:spTree>' + "".join(f"<p:sp><p:txBody><a:p><a:r><a:t>{x}</a:t></a:r></a:p></p:txBody></p:sp>" for x in t) + "</p:spTree></p:cSld></p:sld>"
    build(OUT / "sunum.pptx", {
        "[Content_Types].xml": f'{XML}<Types xmlns="{CT}"><Default Extension="xml" ContentType="application/xml"/></Types>',
        "ppt/slides/slide1.xml": slide("Çeyrek Sonuçları", "2024 Q3 özeti"),
        "ppt/slides/slide2.xml": slide("Gelirler", "Gelir %18 arttı", "Yeni müşteri sayısı: 214"),
        "ppt/slides/slide3.xml": slide("Sonraki adımlar", "Telefondan düzenleme", "Ekip toplantısı Cuma"),
    })


def wav() -> None:
    """3 sn'lik 440 Hz sinüs (16 bit, 22,05 kHz): ses önizlemesinin gerçek bir <audio> ile çalıştığını görmek için."""
    with wave.open(str(OUT / "muzik.wav"), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(22050)
        w.writeframes(b"".join(struct.pack("<h", int(9000 * math.sin(2 * math.pi * 440 * i / 22050))) for i in range(22050 * 3)))


(OUT / "rapor.pdf").write_bytes(pdf())
wav()
docx()
xlsx()
pptx()
print("belgeler:", ", ".join(sorted(p.name for p in OUT.iterdir())))
