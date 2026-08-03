/**
 * Layout email dùng chung — sinh CẢ html (bảng inline-style, an toàn mọi mail client) LẪN text
 * từ một object nội dung, để mọi registrar có mail đồng bộ thương hiệu QLTS. Text giữ nguyên các
 * token nghiệp vụ (mã máy/tên license/link) mà db-spec đang assert → đổi giao diện không phá test.
 */

export type MailTone = 'info' | 'warn' | 'danger';

export interface MailDetail {
  label: string;
  value: string;
}

export interface MailContent {
  title: string;
  /** dòng xem trước (ẩn) hiện trong hộp thư trước khi mở */
  preheader?: string;
  intro: string | string[];
  details?: MailDetail[];
  list?: string[];
  cta?: { label: string; url: string };
  tone?: MailTone;
  footerNote?: string;
}

const TONE: Record<MailTone, { bar: string; soft: string; text: string }> = {
  info: { bar: '#2563eb', soft: '#eff6ff', text: '#1e3a8a' },
  warn: { bar: '#d97706', soft: '#fffbeb', text: '#92400e' },
  danger: { bar: '#dc2626', soft: '#fef2f2', text: '#991b1b' },
};

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const asArray = (v: string | string[]): string[] =>
  Array.isArray(v) ? v : [v];

/** Ngày giờ VN gọn cho mail: 'dd/mm/yyyy HH:mm' (bỏ giây, giờ Asia/Ho_Chi_Minh). */
export function vnDateTime(d: Date): string {
  return d.toLocaleString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function detailsHtml(details: MailDetail[]): string {
  const rows = details
    .map(
      (d) => `<tr>
        <td style="padding:6px 0;color:#64748b;font-size:13px;white-space:nowrap;vertical-align:top">${esc(d.label)}</td>
        <td style="padding:6px 0 6px 16px;color:#0f172a;font-size:14px;font-weight:600">${esc(d.value)}</td>
      </tr>`,
    )
    .join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:8px 0 4px">${rows}</table>`;
}

function listHtml(list: string[], tone: { bar: string }): string {
  const items = list
    .map(
      (i) => `<tr>
        <td style="padding:5px 10px 5px 0;color:${tone.bar};font-size:14px;vertical-align:top">•</td>
        <td style="padding:5px 0;color:#0f172a;font-size:14px;line-height:1.5">${esc(i)}</td>
      </tr>`,
    )
    .join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:8px 0">${items}</table>`;
}

function buttonHtml(cta: { label: string; url: string }, tone: { bar: string }): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0 4px">
    <tr><td style="border-radius:8px;background:${tone.bar}">
      <a href="${esc(cta.url)}" style="display:inline-block;padding:12px 24px;font-family:${FONT};font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px">${esc(cta.label)} →</a>
    </td></tr>
  </table>`;
}

export function renderMail(content: MailContent): { html: string; text: string } {
  const tone = TONE[content.tone ?? 'info'];
  const intros = asArray(content.intro);

  const introHtml = intros
    .map(
      (p) =>
        `<p style="margin:0 0 12px;color:#334155;font-size:15px;line-height:1.6">${esc(p)}</p>`,
    )
    .join('');

  const preheader = content.preheader
    ? `<span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden">${esc(content.preheader)}</span>`
    : '';

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f1f5f9">
${preheader}
<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;background:#f1f5f9;padding:24px 12px">
  <tr><td align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
      <tr><td style="height:4px;background:${tone.bar};font-size:0;line-height:0">&nbsp;</td></tr>
      <tr><td style="padding:18px 28px 0">
        <span style="font-family:${FONT};font-size:13px;font-weight:700;letter-spacing:.5px;color:#0f172a">QLTS</span>
        <span style="font-family:${FONT};font-size:12px;color:#94a3b8"> · Hệ thống Quản lý Tài sản</span>
      </td></tr>
      <tr><td style="padding:14px 28px 4px">
        <div style="display:inline-block;padding:4px 12px;border-radius:999px;background:${tone.soft};color:${tone.text};font-family:${FONT};font-size:12px;font-weight:600">${esc(content.title)}</div>
      </td></tr>
      <tr><td style="padding:12px 28px 24px;font-family:${FONT}">
        ${introHtml}
        ${content.details?.length ? detailsHtml(content.details) : ''}
        ${content.list?.length ? listHtml(content.list, tone) : ''}
        ${content.cta ? buttonHtml(content.cta, tone) : ''}
      </td></tr>
      <tr><td style="padding:16px 28px;border-top:1px solid #f1f5f9;font-family:${FONT};font-size:12px;color:#94a3b8;line-height:1.5">
        ${esc(content.footerNote ?? 'Email tự động từ QLTS — vui lòng không trả lời email này.')}
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

  const textParts: string[] = [content.title, '', ...intros];
  if (content.details?.length) {
    textParts.push('', ...content.details.map((d) => `${d.label}: ${d.value}`));
  }
  if (content.list?.length) {
    textParts.push('', ...content.list.map((i) => `- ${i}`));
  }
  if (content.cta) {
    textParts.push('', `${content.cta.label}: ${content.cta.url}`);
  }
  const text = textParts.join('\n');

  return { html, text };
}
