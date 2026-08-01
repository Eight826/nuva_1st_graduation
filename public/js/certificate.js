/**
 * Client-side certificate PDF generation (pdf-lib + embedded CJK subset).
 * Requires globals: PDFLib, fontkit (optional but needed for OTF/CFF).
 */
(() => {
  const TEMPLATE_URL = "./assets/電子證書正式版.pdf";
  const FONT_URL = "./assets/fonts/NotoSansTC-Bold-subset.ttf";

  /**
   * Name sits in the gap between「恭喜」and「參與」on the Canva template.
   * Coordinates measured from the template text boxes (pt, origin bottom-left).
   */
  const NAME_GAP_CENTER_X = 192.7;
  /** Nudged up so Noto glyph box aligns with Canva「恭喜」line. */
  const NAME_BASELINE_Y = 463.3;
  const BASE_FONT_SIZE = 21;
  const TEXT_COLOR = { r: 0.12, g: 0.12, b: 0.12 };

  let cachedTemplate = null;
  let cachedFontBytes = null;

  async function fetchBytes(url) {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`無法載入資源（${res.status}）`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  async function loadAssets() {
    if (!cachedTemplate) {
      cachedTemplate = await fetchBytes(TEMPLATE_URL);
    }
    if (!cachedFontBytes) {
      cachedFontBytes = await fetchBytes(FONT_URL);
    }
    return { template: cachedTemplate, fontBytes: cachedFontBytes };
  }

  function fontSizeForName(name) {
    const len = Array.from(String(name || "")).length;
    if (len <= 3) return BASE_FONT_SIZE;
    if (len <= 6) return Math.max(12, BASE_FONT_SIZE - (len - 3) * 2);
    return Math.max(10, BASE_FONT_SIZE - 8 - (len - 6));
  }

  /**
   * @param {string} name
   * @returns {Promise<Uint8Array>}
   */
  async function buildCertificatePdf(name) {
    const PDFLib = window.PDFLib;
    if (!PDFLib) {
      throw new Error("pdf-lib 尚未載入");
    }

    const trimmed = String(name || "").trim();
    if (!trimmed) {
      throw new Error("缺少姓名，無法產生證書");
    }

    const { template, fontBytes } = await loadAssets();
    const pdfDoc = await PDFLib.PDFDocument.load(template);

    if (typeof window.fontkit !== "undefined") {
      pdfDoc.registerFontkit(window.fontkit);
    }

    const font = await pdfDoc.embedFont(fontBytes, { subset: true });
    const pages = pdfDoc.getPages();
    if (!pages.length) {
      throw new Error("證書公版無效");
    }

    const page = pages[0];
    const size = fontSizeForName(trimmed);
    const textWidth = font.widthOfTextAtSize(trimmed, size);
    const x = NAME_GAP_CENTER_X - textWidth / 2;

    page.drawText(trimmed, {
      x,
      y: NAME_BASELINE_Y,
      size,
      font,
      color: PDFLib.rgb(TEXT_COLOR.r, TEXT_COLOR.g, TEXT_COLOR.b),
    });

    return pdfDoc.save();
  }

  /**
   * Build and trigger download of `nuva-證書-{name}.pdf`.
   * @param {string} name
   */
  async function downloadCertificate(name) {
    const bytes = await buildCertificatePdf(name);
    const trimmed = String(name || "").trim();
    const blob = new Blob([bytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `nuva-證書-${trimmed}.pdf`;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  window.NuvaCertificate = {
    downloadCertificate,
    buildCertificatePdf,
  };
})();
