import { env } from '../config/env.js';

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);

const paragraph = (text) =>
  `<p style="margin:0 0 16px;color:#475569;font-size:15px;line-height:1.7;white-space:pre-line">${escapeHtml(text)}</p>`;

const detailRows = (details = []) =>
  details.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 22px;border-collapse:collapse;background:#f8fafc;border:1px solid #e8edf4;border-radius:10px">${details
        .map(
          ({ label, value }) =>
            `<tr><td style="padding:11px 14px;border-bottom:1px solid #e8edf4;color:#64748b;font-size:13px">${escapeHtml(label)}</td><td align="right" style="padding:11px 14px;border-bottom:1px solid #e8edf4;color:#0f172a;font-size:14px;font-weight:600;word-break:break-word">${escapeHtml(value)}</td></tr>`,
        )
        .join('')}</table>`
    : '';

export function emailTemplate({ preheader, title, greeting, paragraphs = [], details, paragraphsAfterDetails = [], action, closing }) {
  const actionMarkup = action
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0"><tr><td align="center" bgcolor="#3b5bdb" style="border-radius:8px"><a href="${escapeHtml(action.url)}" style="display:inline-block;padding:13px 22px;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none">${escapeHtml(action.label)}</a></td></tr></table><p style="margin:0 0 18px;color:#64748b;font-size:12px;line-height:1.6">If the button doesn't work, copy and paste this address into your browser:<br><a href="${escapeHtml(action.url)}" style="color:#3b5bdb;word-break:break-all">${escapeHtml(action.url)}</a></p>`
    : '';
  const footer = closing || 'This is an automated message from IsaPay. Please do not share passwords, M-Pesa PINs, API keys or webhook secrets by email.';

  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(title)}</title></head>
  <body style="margin:0;padding:0;background:#f4f6fa;font-family:Arial,Helvetica,sans-serif;color:#0f172a">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeHtml(preheader || title)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fa;padding:32px 12px">
      <tr><td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;border-collapse:separate;border-spacing:0">
          <tr><td style="padding:0 0 18px">
            <table role="presentation" cellpadding="0" cellspacing="0"><tr>
              <td width="40" height="40" align="center" bgcolor="#3b5bdb" style="width:40px;height:40px;border-radius:11px;color:#ffffff;font-size:18px;font-weight:800">I</td>
              <td style="padding-left:11px;color:#0f172a;font-size:17px;font-weight:800">IsaPay <span style="color:#64748b;font-size:12px;font-weight:500">by ISA Tech</span></td>
            </tr></table>
          </td></tr>
          <tr><td style="padding:34px 36px 28px;background:#ffffff;border:1px solid #e8edf4;border-radius:14px">
            <p style="margin:0 0 8px;color:#3b5bdb;font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase">IsaPay account &amp; payments</p>
            <h1 style="margin:0 0 22px;color:#0f172a;font-size:24px;line-height:1.3">${escapeHtml(title)}</h1>
            ${greeting ? paragraph(greeting) : ''}
            ${paragraphs.map(paragraph).join('')}
            ${detailRows(details)}
            ${paragraphsAfterDetails.map(paragraph).join('')}
            ${actionMarkup}
            ${closing ? '' : '<p style="margin:22px 0 0;color:#64748b;font-size:13px;line-height:1.6">If you need help, contact IsaPay support.</p>'}
          </td></tr>
          <tr><td style="padding:18px 12px 0;color:#64748b;font-size:12px;line-height:1.6;text-align:center">
            <p style="margin:0 0 6px">${escapeHtml(footer)}</p>
            <p style="margin:0">&copy; ${new Date().getFullYear()} ISA Tech · IsaPay</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

export const dashboardLink = (path) => `${env.appUrl}${path}`;
