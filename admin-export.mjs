// CSV is UTF-8 with a BOM so Excel recognises Turkish and other Unicode text.
export function applicationsCsv(applications) {
  const fields = [
    ['Application reference', 'id'], ['Submitted (UTC)', 'created_at'],
    ['Full name', 'full_name'], ['Email', 'email'], ['Country', 'country_of_residence'],
    ['Phone', 'phone'], ['WhatsApp', 'whatsapp'], ['Signal', 'signal'], ['LinkedIn', 'linkedin'],
    ['Professional expertise', 'professional_expertise'], ['Thematic expertise', 'thematic_expertise'],
    ['Additional information', 'additional_information'], ['Associate interest', 'associate_interest'],
    ['Future opportunities consent', 'privacy_consent'], ['CV file', 'cv_filename'],
    ['CV archive path', null], ['Email notification sent', 'notification_sent']
  ];
  function cell(value) {
    let text = Array.isArray(value) ? value.join('; ') : typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value ?? '');
    // Treat applicant-controlled formulas as text when opened in a spreadsheet.
    if (/^[\s\u0000-\u001f]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  }
  return '\ufeff' + [fields.map(([label]) => cell(label)).join(','), ...applications.map(app => fields.map(([, key]) => cell(key ? app[key] : cvArchivePath(app))).join(','))].join('\r\n') + '\r\n';
}

export function cvArchivePath(app) {
  const name = String(app.full_name || 'Applicant').normalize('NFKC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 100) || 'Applicant';
  return `${name}_${app.id}/cv${app.cv_filename?.endsWith('.docx') ? '.docx' : '.pdf'}`;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0);
  return n >>> 0;
});
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

// Stream a standard, uncompressed ZIP; keep only one decrypted CV in memory.
export async function* zipFiles(entries) {
  const directory = [];
  let offset = 0;
  for await (const { name, data } of entries) {
    const filename = Buffer.from(name, 'utf8');
    if (offset + data.length + filename.length + 30 > 0xffffffff || directory.length >= 65535) throw new Error('Archive exceeds ZIP size limits');
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(33, 12); header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8); central.writeUInt16LE(33, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    directory.push(Buffer.concat([central, filename]));
    yield header; yield filename; yield data;
    offset += header.length + filename.length + data.length;
  }
  const start = offset;
  for (const entry of directory) { yield entry; offset += entry.length; }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(directory.length, 8); end.writeUInt16LE(directory.length, 10);
  end.writeUInt32LE(offset - start, 12); end.writeUInt32LE(start, 16);
  yield end;
}
