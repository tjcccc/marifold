// Device-control strings: OSC, DCS, SOS, PM, and APC in 7-bit and 8-bit form,
// terminated by BEL or ST. An unterminated introducer is removed on its own,
// leaving its payload as visible text.
const STRING_SEQUENCE = /(?:\x1b[\]PX^_]|[\x90\x98\x9d\x9e\x9f])[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)/g;
const STRING_INTRODUCER = /\x1b[\]PX^_]|[\x90\x98\x9d\x9e\x9f]/g;
const CSI = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g;
const ESCAPE = /\x1b[ -/]*[0-~]/g;
// C0 controls except tab and newline, DEL, and C1 controls (ESC included).
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/** Remove device-control strings such as OSC 52 clipboard writes, OSC 0/2
 * window titles, OSC 8 hyperlinks, and terminal file transfers, keeping CSI
 * cursor and color sequences. For output whose CSI a renderer already owns. */
export function stripTerminalStrings(text: string): string {
  return text.replace(STRING_SEQUENCE, '').replace(STRING_INTRODUCER, '');
}

/** Make untrusted text (model, tool, or remote output) inert in a terminal.
 * Every escape sequence and control character except tab and newline is
 * removed, so the text cannot write the clipboard, retitle the window, spoof
 * links, or move the cursor to rewrite earlier output such as an approval
 * prompt. Removing the control characters themselves also neutralizes a
 * sequence split across streamed chunks. */
export function stripTerminalControls(text: string): string {
  return stripTerminalStrings(text.replace(/\r\n/g, '\n'))
    .replace(CSI, '')
    .replace(ESCAPE, '')
    .replace(CONTROL, '');
}
