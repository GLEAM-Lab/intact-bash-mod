// IntAct for Claude Code's Bash tool on Windows, as a mod (Claude Code 2.1.287 or later).
//
// On Windows the Bash tool wraps the command as  eval '<text>'  inside one bash -c string. At that hop the MSYS2
// runtime cuts a quoted argument at 8,186 UTF-16 code units and merges backslash pairs. A file read by the shell
// crosses neither, so this mod writes a hazardous command to a file and replaces the tool input with  . '<file>'
// (sourced in the same shell: cd, exports and the exit status behave as before).
//
// Rule, as the hook of the plugin (../../claude-code-plugin/hooks/win_bash_delivery.py): reroute a command longer
// than LIMIT characters, or one with a heredoc or a backslash pair; refuse a command that no channel carries (a
// carriage return before a line feed) or that asks how it was read; pass everything else. The mod runs inside
// Claude Code, so no process is started per call. Set INTACT_BASH_DELIVERY=off to disable.
//
// Measuring mode (INTACT_MOD_MEASURE=1, for benchmarks only): the hook renders the call and then answers it itself
// with the time the rendering took, so that nothing is executed.

const LIMIT = 200
const REFUSAL_CR =
  'Not run (hop: shell parse). Git Bash drops a carriage return before a line feed when it reads a command, so this ' +
  'command would have run without its %d carriage return(s). Nothing was executed.'
const REFUSAL_SOURCED =
  'Not run (hop: host wrapper). This command uses %s, which bash treats differently when it reads the command from a ' +
  'file, as this delivery does, than from a command line. Nothing was executed.'

const SRC_VARS = [
  ['BASH_SOURCE', /\$\{?#?!?BASH_SOURCE\b|\bBASH_SOURCE\[/],
  ['BASH_EXECUTION_STRING', /\$\{?#?!?BASH_EXECUTION_STRING\b/],
  ['FUNCNAME', /\$\{?#?!?FUNCNAME\b|\bFUNCNAME\[/],
]
const CMDPOS = '(?:^|[;&|(){}\\n]|\\b(?:then|do|else|elif|if|while|until|!)\\s)\\s*'
const SRC_CALLER = new RegExp(CMDPOS + 'caller(?=\\s|;|$|\\))', 'm')
const SRC_RETURN = new RegExp(CMDPOS + 'return(?=\\s|;|$|\\))', 'm')
const SRC_FUNC = /(?:^|[\s;&|])(?:function\s+[\w.:-]+|[\w.:-]+\s*\(\s*\))\s*(?:\{|\()/m
const HEREDOC = /^<<(-?)\s*(['"]?)([A-Za-z0-9_.-]+)\2/

// (expanding, code): the text without single-quoted strings, comments and quoted-delimiter here-document bodies;
// and that without double-quoted strings and any here-document body
function shellViews(text) {
  const exp = []
  const code = []
  const n = text.length
  let i = 0
  let pending = []
  let wordStart = true
  while (i < n) {
    const c = text[i]
    if (c === '\\' && i + 1 < n) {
      exp.push(text.slice(i, i + 2)); code.push(' '); i += 2; wordStart = false; continue
    }
    if (c === "'") {
      const j = text.indexOf("'", i + 1)
      i = j < 0 ? n : j + 1; exp.push(' '); code.push(' '); wordStart = false; continue
    }
    if (c === '$' && text.startsWith("$'", i)) {
      let j = i + 2
      while (j < n && text[j] !== "'") j += text[j] === '\\' ? 2 : 1
      i = j + 1; exp.push(' '); code.push(' '); continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      exp.push(text.slice(i, j + 1)); code.push(' '); i = j + 1; wordStart = false; continue
    }
    if (c === '#' && wordStart) {
      const j = text.indexOf('\n', i)
      i = j < 0 ? n : j
      continue
    }
    if (text.startsWith('<<', i) && !text.startsWith('<<<', i)) {
      const m = HEREDOC.exec(text.slice(i))
      if (m) {
        pending.push([m[3], Boolean(m[1]), Boolean(m[2])])
        exp.push(m[0]); code.push(' '); i += m[0].length; continue
      }
    }
    if (c === '\n') {
      exp.push(c); code.push(c); i += 1; wordStart = true
      for (const [delim, tabs, quoted] of pending) {
        while (i < n) {
          const j = text.indexOf('\n', i)
          const line = text.slice(i, j < 0 ? n : j)
          i = j < 0 ? n : j + 1
          if ((tabs ? line.replace(/^\t+/, '') : line) === delim) break
          if (!quoted) exp.push(line + '\n')
        }
      }
      pending = []
      continue
    }
    exp.push(c); code.push(c); i += 1
    wordStart = ' \t;&|(){}'.includes(c)
  }
  return [exp.join(''), code.join('')]
}

// the constructs of a text whose behaviour differs when bash reads it from a sourced file
function sourceSensitive(text) {
  const [exp, code] = shellViews(text)
  const found = SRC_VARS.filter(([, rx]) => rx.test(exp)).map(([name]) => name)
  if (SRC_CALLER.test(code)) found.push('caller')
  if (SRC_RETURN.test(code) && !SRC_FUNC.test(code)) found.push('return outside a function')
  return found
}

function toPosix(path) {
  let p = path.replace(/\\/g, '/')
  if (p.length > 1 && p[1] === ':') p = '/' + p[0].toLowerCase() + p.slice(2)
  return p
}

function fromPosix(path) {
  return /^\/[a-z]\//.test(path) ? path[1].toUpperCase() + ':' + path.slice(2).replace(/\//g, '\\') : path
}

// the statement that delivers a command as a file, and the path of that file
const STATEMENT = /^\. '([^']*\/claude-cmd\/[^']+\.sh)'  # delivered as a file \(\d+ chars\): /

// The engine's permission decision on the command that a delivery statement delivers (read back from its file and
// asked as a query, which runs nothing); undefined when the input is no such statement or the file cannot be read.
async function deliveredDecision($, input) {
  const cmd = input && typeof input === 'object' ? input.command : undefined
  const m = typeof cmd === 'string' ? STATEMENT.exec(cmd) : null
  if (!m) return undefined
  let delivered
  try {
    delivered = await $.fs.read(fromPosix(m[1]))
  } catch {
    return undefined
  }
  if (typeof delivered !== 'string') return undefined
  const command = delivered.endsWith('\n') ? delivered.slice(0, -1) : delivered
  return $.tool.check({ tool: 'Bash', input: { ...input, command } })
}

// what makes the rule reroute a command
function triggers(cmd) {
  const t = []
  if (cmd.length > LIMIT) t.push('length')
  if (cmd.includes('<<')) t.push('heredoc')
  if (cmd.includes('\\\\')) t.push('backslash pair')
  return t
}

async function digest(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text)))
  return Array.from(bytes.slice(0, 6), b => b.toString(16).padStart(2, '0')).join('')
}

// Decide one Bash call. Returns { pass }, { deny } or { command } (the rendered call, after writing the file), each
// with why: what decided it (the triggers of the rule, or the reason the rule did not apply).
async function render($, cmd) {
  if (typeof cmd !== 'string' || !cmd.trim()) return { pass: true, why: ['empty'] }
  if ((await $.env.get('OS')) !== 'Windows_NT') return { pass: true, why: ['not Windows'] }
  if (((await $.env.get('INTACT_BASH_DELIVERY')) || '').toLowerCase() === 'off') return { pass: true, why: ['off'] }
  if (cmd.includes('\r\n')) return { deny: REFUSAL_CR.replace('%d', String(cmd.split('\r\n').length - 1)), why: ['CRLF'] }
  if (cmd.trimStart().startsWith(". '") && cmd.slice(0, 200).includes('claude-cmd')) {
    return { pass: true, why: ['already a delivery statement'] }
  }
  const why = triggers(cmd)
  if (!why.length) return { pass: true, why }
  const found = sourceSensitive(cmd)
  if (found.length) return { deny: REFUSAL_SOURCED.replace('%s', found.join(', ')), why: why.concat(found) }
  const base = (await $.env.get('LOCALAPPDATA')) || (await $.env.get('TEMP'))
  if (!base) return { pass: true, why: why.concat(['no directory for the file']) }
  // the separator of the base path, so that a base given with forward slashes yields one path, not a file name
  const sep = base.includes('\\') ? '\\' : '/'
  const dir = base.includes('Temp') ? base + sep + 'claude-cmd' : base + sep + 'Temp' + sep + 'claude-cmd'
  const now = await $.clock.now()
  const path = dir + sep + Math.floor(now / 1000) + '-' + (await digest(cmd)) + '.sh'
  await $.fs.write(path, cmd.endsWith('\n') ? cmd : cmd + '\n')
  const first = cmd.trim().split('\n')[0].slice(0, 120)
  return { command: ". '" + toPosix(path) + "'  # delivered as a file (" + cmd.length + ' chars): ' + first, why }
}

// One record per call, counts only and no command text, in its own file (the mod's file interface has no append):
// %LOCALAPPDATA%\intact-mod\log\<session id>\<time>-<random>.json with the time, the session, the action (pass,
// reroute, refuse), the command's length, what decided the action, and the milliseconds the rendering took.
// INTACT_MOD_LOG=on writes them, INTACT_MOD_LOG=off does not; without it, LOG_DEFAULT decides.
const LOG_DEFAULT = false
async function log($, cmd, r, ms, now) {
  try {
    const flag = ((await $.env.get('INTACT_MOD_LOG')) || '').toLowerCase()
    if (!(flag === 'on' || (LOG_DEFAULT && flag !== 'off'))) return
    const base = (await $.env.get('LOCALAPPDATA')) || (await $.env.get('TEMP'))
    if (!base) return
    const sep = base.includes('\\') ? '\\' : '/'
    const session = String(await $.session.id())
    const rec = {
      time: now,
      session,
      action: r.pass ? 'pass' : r.deny ? 'refuse' : 'reroute',
      length: typeof cmd === 'string' ? cmd.length : 0,
      why: r.why || [],
      render_ms: ms,
    }
    const name = now + '-' + Math.random().toString(36).slice(2, 8) + '.json'
    await $.fs.write([base, 'intact-mod', 'log', session, name].join(sep), JSON.stringify(rec))
  } catch {
    // a record that cannot be written changes nothing about the call
  }
}

export function register(on) {
  // The permission decision. Claude Code decides on the call it runs, which after a reroute is the delivery
  // statement; the mod answers with the engine's decision on the command the statement delivers, so that a deny
  // rule, an ask and the Bash tool's own checks apply to the command as they would without the mod. When the file
  // cannot be read, the statement is decided as it stands.
  on('tool.check', { tool: 'Bash' }, async ($, e, next) => (await deliveredDecision($, e.input)) || next(e))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const measuring = (await $.env.get('INTACT_MOD_MEASURE')) === '1'
    const t0 = await $.clock.now()
    const r = await render($, e.command)
    const t1 = await $.clock.now()
    if (measuring) {
      // the decision a rerouted call then gets and the time it takes (read the file back, ask the engine), against
      // the time of the engine's own decision on the command as Claude Code takes it without the mod
      let check_ms = null
      let own_check_ms = null
      let decision = null
      if (r.command) {
        const b0 = await $.clock.now()
        await $.tool.check({ tool: 'Bash', input: { command: e.command } })
        const b1 = await $.clock.now()
        const d = await deliveredDecision($, { command: r.command })
        check_ms = (await $.clock.now()) - b1
        own_check_ms = b1 - b0
        decision = d ? d.decision : 'unread'
      }
      // an answer to a Bash call has the shape of the Bash tool's own result
      const outcome = r.pass ? 'pass' : r.deny ? 'deny' : 'reroute'
      const stdout = JSON.stringify({ ms: t1 - t0, check_ms, own_check_ms, decision, outcome })
      return { result: { stdout, stderr: '', interrupted: false, isImage: false, noOutputExpected: false } }
    }
    await log($, e.command, r, t1 - t0, t1)
    if (r.pass) return next(e)
    if (r.deny) return { deny: r.deny }
    return next({ ...e, command: r.command })
  })
}
