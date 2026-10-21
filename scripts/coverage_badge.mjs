// Prints a shields.io endpoint badge for the line coverage in a c8 json-summary report.
// The docs workflow publishes it to GitHub Pages for the README coverage badge.
import { readFile } from 'node:fs/promises'

const summary = JSON.parse(await readFile(process.argv[2], 'utf8'))
const percent = Math.floor(summary.total.lines.pct)
const color = percent >= 90 ? 'brightgreen' : percent >= 80 ? 'yellow' : 'red'

console.log(JSON.stringify({ schemaVersion: 1, label: 'coverage', message: `${percent}%`, color }))
