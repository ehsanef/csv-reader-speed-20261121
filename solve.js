// Fast drop-in for csv-reader 1.0.0 (make.fun's own reference CSV reader).
// run(input) returns exactly csv-reader's {columns, rows, errors} for every
// {text, header}, with the same broken-row policy:
//
//   - U+FEFF at the very start is dropped; a record ends at LF or CRLF, and a
//     line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field opening with a quote runs to the next quote that is not doubled
//     ("" inside it is one quote, CRLF / lone CR inside it read as LF); what
//     follows its closing quote up to the next comma or line break is appended
//     as it stands (quote_junk, when the field ends); a quote that never
//     closes is a literal character and the text after it is read again as
//     unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds
//     the records after it, each padded (short_row, with fields: its count)
//     or cut (long_row, with extra: the cut fields) to the first record's
//     width; each error is {code, line, row} in the order met, line the
//     1-based line its record starts on (every LF, CRLF and lone CR inside
//     quotes counted), row its record's index in rows, null for the header.
//
// Speed: the reference walks one character at a time and builds every field
// a character at a time. This reader instead slices fields out of the text
// with indexOf (short, bounded scans) and takes a whole-line fast path for
// records that hold no quote and no stray CR: one slice plus a split(',')
// per record. Quoted fields are sliced between quotes, with a slow path
// only for doubled quotes, embedded line breaks, stray CRs and quote junk
// -- the rare cases. Every scan is bounded to the field or line it decides
// (an unbounded indexOf('\r') would run past the field into the rest of the
// file on LF files). No state is kept between calls.

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // Per-record state, read by the helpers below.
  let recordLine = 1;
  let recordRow = null;

  // Slow unquoted scan, used only when a stray CR, quote junk or an
  // unterminated quote is in play. Appends characters from pos up to the
  // next comma or line break onto `initial`, dropping lone CRs (each one a
  // stray_cr error). Returns {value, ended, added} where ended is
  // 'comma' | 'line' | 'end' and added counts the characters kept in this
  // call (not the initial value's length).
  function slowUnquoted(initial) {
    let value = initial;
    let added = 0;
    while (pos < n) {
      const cIdx = text.indexOf(',', pos);
      const nIdx = text.indexOf('\n', pos);
      const rIdx = text.indexOf('\r', pos);
      let end = -1;
      let kind = 0; // 1 comma, 2 LF, 3 CR
      if (cIdx !== -1) { end = cIdx; kind = 1; }
      if (nIdx !== -1 && (end === -1 || nIdx < end)) { end = nIdx; kind = 2; }
      if (rIdx !== -1 && (end === -1 || rIdx < end)) { end = rIdx; kind = 3; }
      if (end === -1) {
        value += text.slice(pos);
        added += n - pos;
        pos = n;
        return { value, ended: 'end', added };
      }
      if (kind === 1) {
        value += text.slice(pos, end);
        added += end - pos;
        pos = end + 1;
        return { value, ended: 'comma', added };
      }
      if (kind === 2) {
        value += text.slice(pos, end);
        added += end - pos;
        pos = end + 1;
        line += 1;
        return { value, ended: 'line', added };
      }
      // CR: CRLF ends the field, a lone CR is dropped with an error.
      if (end + 1 < n && text.charCodeAt(end + 1) === 10) {
        value += text.slice(pos, end);
        added += end - pos;
        pos = end + 2;
        line += 1;
        return { value, ended: 'line', added };
      }
      value += text.slice(pos, end);
      added += end - pos;
      pos = end + 1;
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
    }
    return { value, ended: 'end', added };
  }

  // Finish one record: header, short/long padding and cutting, row push.
  // A single empty unquoted field is no record at all.
  function finish(fields, quoted) {
    if (fields.length === 1 && fields[0] === '' && !quoted) return;
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Whole-line fast path: the physical line, sliced once. If it holds no
    // quote and no CR (a trailing CRLF's CR stripped first), the line is
    // one record, split on commas.
    const lineEndIdx = text.indexOf('\n', pos);
    const lineEnd = lineEndIdx === -1 ? n : lineEndIdx;
    let lineText = text.slice(pos, lineEnd);
    if (lineEndIdx !== -1 && lineText.charCodeAt(lineText.length - 1) === 13) {
      lineText = lineText.slice(0, -1);
    }
    if (lineText.indexOf('"') === -1 && lineText.indexOf('\r') === -1) {
      const fields = lineText.split(',');
      pos = lineEndIdx === -1 ? n : lineEnd + 1;
      if (lineEndIdx !== -1) line += 1;
      finish(fields, false);
      continue;
    }

    // Slow path: this record holds a quote, a stray CR, or both.
    const fields = [];
    let lastQuoted = false;
    for (;;) {
      let fieldValue;
      let fieldEnded;
      if (pos >= n) {
        fieldValue = '';
        fieldEnded = 'end';
        lastQuoted = false;
      } else if (text.charCodeAt(pos) === 34) {
        // Quoted field.
        lastQuoted = true;
        const open = pos;
        const openLine = line;
        pos += 1;
        let value = '';
        let segStart = pos;
        let qline = line;
        let closed = false;
        let unterminated = false;
        while (true) {
          const q = text.indexOf('"', pos);
          if (q === -1) {
            // The quote never closes: it is a literal character, and the
            // text after it is read again as unquoted.
            pos = open + 1;
            line = openLine;
            errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
            const r = slowUnquoted('"');
            fieldValue = r.value;
            fieldEnded = r.ended;
            unterminated = true;
            break;
          }
          if (q + 1 < n && text.charCodeAt(q + 1) === 34) {
            // Doubled quote: append the segment, then one quote.
            const seg = text.slice(segStart, q);
            if (seg.indexOf('\n') === -1 && seg.indexOf('\r') === -1) {
              value += seg;
            } else {
              let cnt = 0;
              for (let i = 0; i < seg.length; i++) {
                const ch = seg.charCodeAt(i);
                if (ch === 13) {
                  cnt += 1;
                  if (seg.charCodeAt(i + 1) === 10) i += 1;
                } else if (ch === 10) {
                  cnt += 1;
                }
              }
              qline += cnt;
              value += seg.indexOf('\r') === -1 ? seg : seg.replace(/\r\n?/g, '\n');
            }
            value += '"';
            pos = q + 2;
            segStart = pos;
            continue;
          }
          const seg = text.slice(segStart, q);
          if (seg.indexOf('\n') === -1 && seg.indexOf('\r') === -1) {
            value += seg;
          } else {
            let cnt = 0;
            for (let i = 0; i < seg.length; i++) {
              const ch = seg.charCodeAt(i);
              if (ch === 13) {
                cnt += 1;
                if (seg.charCodeAt(i + 1) === 10) i += 1;
              } else if (ch === 10) {
                cnt += 1;
              }
            }
            qline += cnt;
            value += seg.indexOf('\r') === -1 ? seg : seg.replace(/\r\n?/g, '\n');
          }
          pos = q + 1;
          line = qline;
          closed = true;
          break;
        }
        if (!unterminated && closed) {
          if (pos >= n) {
            fieldValue = value;
            fieldEnded = 'end';
          } else {
            const c = text.charCodeAt(pos);
            if (c === 44) {
              pos += 1;
              fieldValue = value;
              fieldEnded = 'comma';
            } else if (c === 10) {
              pos += 1;
              line += 1;
              fieldValue = value;
              fieldEnded = 'line';
            } else if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
              pos += 2;
              line += 1;
              fieldValue = value;
              fieldEnded = 'line';
            } else {
              // What follows the closing quote is appended as it stands.
              const r = slowUnquoted(value);
              if (r.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
              fieldValue = r.value;
              fieldEnded = r.ended;
            }
          }
        }
      } else {
        // Unquoted field: slice to the next comma or line break, then
        // check that short slice (bounded) for a stray CR.
        lastQuoted = false;
        const cIdx = text.indexOf(',', pos);
        const nIdx = text.indexOf('\n', pos);
        if (cIdx === -1 && nIdx === -1) {
          const v = text.slice(pos);
          if (v.indexOf('\r') === -1) {
            fieldValue = v;
            pos = n;
            fieldEnded = 'end';
          } else {
            const r = slowUnquoted('');
            fieldValue = r.value;
            fieldEnded = r.ended;
          }
        } else if (nIdx !== -1 && (cIdx === -1 || nIdx < cIdx)) {
          let v = text.slice(pos, nIdx);
          if (v.charCodeAt(v.length - 1) === 13) {
            v = v.slice(0, -1);
          }
          if (v.indexOf('\r') === -1) {
            fieldValue = v;
            pos = nIdx + 1;
            line += 1;
            fieldEnded = 'line';
          } else {
            const r = slowUnquoted('');
            fieldValue = r.value;
            fieldEnded = r.ended;
          }
        } else {
          const v = text.slice(pos, cIdx);
          if (v.indexOf('\r') === -1) {
            fieldValue = v;
            pos = cIdx + 1;
            fieldEnded = 'comma';
          } else {
            const r = slowUnquoted('');
            fieldValue = r.value;
            fieldEnded = r.ended;
          }
        }
      }
      fields.push(fieldValue);
      if (fieldEnded !== 'comma') break;
    }
    finish(fields, lastQuoted);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
