// Builds an asciicast v2 recording in memory and writes it to a file.
import { writeFileSync } from 'node:fs'

export class Cast {
  events: [number, 'o', string][] = []
  t = 0.5
  emit(text: string, gap = 0) {
    this.t += gap
    this.events.push([Number(this.t.toFixed(3)), 'o', text.replace(/\n/g, '\r\n')])
  }
  type(command: string) {
    this.emit('\x1b[32m$\x1b[0m ', 0.5)
    for (const ch of command) this.emit(ch, 0.025)
    this.emit('\n', 0.3)
  }
  comment(text: string) {
    this.emit(`\x1b[90m# ${text}\x1b[0m\n`, 0.7)
  }
  /** Prints output, truncating long lines with an ellipsis to fit the recording width. */
  print(text: string, gap = 0.4) {
    const lines = text.replace(/\n$/, '').split('\n').map(fit)
    this.emit(lines.join('\n') + '\n', gap)
  }
  save(file: string, title: string) {
    const header = { version: 2, width, height: 24, title }
    const lines = [header, ...this.events].map((e) => JSON.stringify(e))
    writeFileSync(file, lines.join('\n') + '\n')
  }
}

const width = 100
/** Cuts a line to the terminal width, ignoring color codes when counting. */
export function fit(line: string) {
  // ANSI escape is a literal terminal control sequence.
  // eslint-disable-next-line no-control-regex
  const visible = line.replace(/\x1b\[[0-9;]*m/g, '')
  if (visible.length <= width - 2) return line
  let count = 0
  let out = ''
  for (let i = 0; i < line.length; i++) {
    // eslint-disable-next-line no-control-regex
    const code = line.slice(i).match(/^\x1b\[[0-9;]*m/)
    if (code) {
      out += code[0]
      i += code[0].length - 1
      continue
    }
    if (count === width - 3) break
    out += line[i]
    count++
  }
  return out + '…\x1b[0m'
}
