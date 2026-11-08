import { util } from '@kit.ArkTS';

export function mailQuote(text: string): string {
  if (/[\r\n\x00]/.test(text) || text.length > 4096) { throw new Error('邮箱参数含非法控制字符或过长'); }
  return '"' + text.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}
export function mailAddress(text: string): string {
  const value = text.trim();
  if (!/^[A-Za-z0-9.!#$%&'*+\-/=?^_`{|}~]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(value) || value.length > 320) {
    throw new Error('请使用完整邮箱地址，多个收件人用英文逗号分隔');
  }
  return value;
}
export function mailBase64(text: string): string {
  return new util.Base64Helper().encodeToStringSync(new util.TextEncoder().encodeInto(text));
}
export function mailDecode(bytes: Uint8Array, charset: string = 'utf-8'): string {
  try { return util.TextDecoder.create(charset.toLowerCase()).decodeToString(bytes); }
  catch (_err) { return util.TextDecoder.create('utf-8').decodeToString(bytes); }
}
export function mailboxWire(text: string): string {
  let output = '', run = '';
  const flush = (): void => {
    if (!run) { return; }
    const bytes = new Uint8Array(run.length * 2);
    for (let i = 0; i < run.length; i++) { bytes[i * 2] = run.charCodeAt(i) >> 8; bytes[i * 2 + 1] = run.charCodeAt(i) & 255; }
    output += '&' + new util.Base64Helper().encodeToStringSync(bytes).replace(/\//g, ',').replace(/=+$/, '') + '-';
    run = '';
  };
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 32 && code <= 126) { flush(); output += text[i] === '&' ? '&-' : text[i]; }
    else { run += text[i]; }
  }
  flush(); return output;
}
export function mailboxDisplay(text: string): string {
  return text.replace(/&([A-Za-z0-9+,]*)-/g, (_match: string, value: string) => {
    if (!value) { return '&'; }
    const padded = value.replace(/,/g, '/') + '='.repeat((4 - value.length % 4) % 4);
    const bytes = new util.Base64Helper().decodeSync(padded);
    let result = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) { result += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]); }
    return result;
  });
}
export function decodeHeader(text: string): string {
  return text.replace(/(\?=)[\r\n \t]+(?==\?)/g, '$1').replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_match: string, charset: string, encoding: string, value: string) => {
    try {
      if (encoding.toLowerCase() === 'b') { return mailDecode(new util.Base64Helper().decodeSync(value), charset); }
      const raw = value.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_m: string, hex: string) => String.fromCharCode(parseInt(hex, 16)));
      return mailDecode(new Uint8Array(raw.split('').map((character: string) => character.charCodeAt(0))), charset);
    } catch (_err) { return '[无法解码的邮件标题]'; }
  });
}
export function mailHeaders(raw: string): Record<string, string> {
  const header = raw.split(/\r?\n\r?\n/, 1)[0].replace(/\r?\n[ \t]+/g, ' ');
  const result: Record<string, string> = {};
  header.split(/\r?\n/).forEach((line: string) => {
    const colon = line.indexOf(':');
    if (colon > 0) { result[line.slice(0, colon).toLowerCase()] = decodeHeader(line.slice(colon + 1).trim()); }
  });
  return result;
}
export function mimeText(raw: string, depth: number = 0): string {
  if (depth > 8) { return '[邮件嵌套过深]'; }
  const headers = mailHeaders(raw);
  const separator = /\r?\n\r?\n/.exec(raw);
  const body = separator ? raw.slice((separator.index ?? 0) + separator[0].length) : '';
  const type = headers['content-type'] ?? 'text/plain';
  const boundary = /boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(type);
  if (/multipart\//i.test(type) && boundary) {
    const parts = body.split('--' + (boundary[1] ?? boundary[2])).slice(1).filter((part: string) => !part.startsWith('--'));
    const plain = parts.filter((part: string) => /content-type:\s*text\/plain/i.test(part));
    return (plain.length ? plain : parts).map((part: string) => mimeText(part.replace(/^\r?\n/, ''), depth + 1)).filter((value: string) => value.length > 0).join('\n');
  }
  if (!/^text\/(plain|html)/i.test(type)) { return ''; }
  const charset = /charset\s*=\s*"?([^;"\s]+)/i.exec(type)?.[1] ?? 'utf-8';
  const encoding = (headers['content-transfer-encoding'] ?? '').toLowerCase();
  let text = body;
  if (encoding === 'base64') { text = mailDecode(new util.Base64Helper().decodeSync(body.replace(/\s/g, '')), charset); }
  else if (encoding === 'quoted-printable') {
    const rawText = body.replace(/=\r?\n/g, '').replace(/=([A-Fa-f0-9]{2})/g, (_m: string, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    text = mailDecode(new Uint8Array(rawText.split('').map((character: string) => character.charCodeAt(0))), charset);
  }
  if (/^text\/html/i.test(type)) {
    text = text.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<\/(?:p|div|li|tr)>|<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }
  return text.trim();
}
export function composeMail(from: string, to: string[], cc: string[], subject: string, body: string): string {
  mailAddress(from); to.forEach((value: string) => { mailAddress(value); }); cc.forEach((value: string) => { mailAddress(value); });
  if (/[\r\n\x00]/.test(subject) || subject.length > 1000 || body.length > 500000) { throw new Error('邮件主题含非法字符或正文过长'); }
  const headers = ['From: ' + from, 'To: ' + to.join(', '), 'Subject: ' + encodedSubject(subject),
    'Date: ' + new Date().toUTCString(), 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64'];
  if (cc.length) { headers.push('Cc: ' + cc.join(', ')); }
  return headers.join('\r\n') + '\r\n\r\n' + (mailBase64(body).match(/.{1,76}/g) ?? []).join('\r\n') + '\r\n';
}

function encodedSubject(subject: string): string {
  const characters = Array.from(subject);
  const words: string[] = [];
  for (let i = 0; i < characters.length; i += 10) {
    words.push('=?UTF-8?B?' + mailBase64(characters.slice(i, i + 10).join('')) + '?=');
  }
  return words.join('\r\n ');
}
