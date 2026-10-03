import { expect, test } from 'claude-code/testing'

// What Claude Code would answer: the environment of a Windows session, a clock, a file system that records writes,
// and the Bash tool, which reports the command it was given
function stubs(on, written: Map<string, string>, env: Record<string, string | undefined> = {}) {
  const vars = { OS: 'Windows_NT', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', ...env }
  on('env.get', ($, e) => ({ value: vars[e.name] }))
  on('clock.now', () => ({ value: 1790000000000 }))
  on('session.id', () => ({ value: 'session-1' }))
  on('fs.write', ($, e) => {
    written.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', ($, e) => {
    if (!written.has(e.path)) throw new Error('no such file')
    return { value: written.get(e.path) }
  })
  on('tool.call', ($, e) => ({ result: { ran: e.command } }))
  // the engine's permission decision: a deny rule for rm, an ask for git push, everything else allowed
  on('tool.check', ($, e) => {
    const c = String(e.input.command)
    if (/(^|[;&|\n]\s*)rm\s/.test(c)) return { decision: 'deny', reason: 'denied by rule', rule: 'Bash(rm:*)' }
    if (/(^|[;&|\n]\s*)git push\b/.test(c)) return { decision: 'ask', reason: 'needs approval' }
    return { decision: 'allow' }
  })
}

// the statement the mod passes on for a command it reroutes
async function rerouted($, command) {
  const out = await $.tool.call({ tool: 'Bash', command })
  return out.result.ran
}

test('a rerouted command is decided as the command it delivers: a deny rule still denies it', async ($, on) => {
  const written = new Map<string, string>()
  stubs(on, written)
  const statement = await rerouted($, "rm -rf build <<'EOF'\nx\nEOF")
  expect(statement).toMatch(/^\. '/)
  expect(await $.tool.check({ tool: 'Bash', input: { command: statement } })).toMatchObject({ decision: 'deny', rule: 'Bash(rm:*)' })
})

test('a rerouted command that needs approval is still asked for, and an allowed one is allowed', async ($, on) => {
  const written = new Map<string, string>()
  stubs(on, written)
  const ask = await rerouted($, "git push origin main # \\\\")
  expect(await $.tool.check({ tool: 'Bash', input: { command: ask } })).toMatchObject({ decision: 'ask' })
  const allow = await rerouted($, "cat <<'EOF'\nx\nEOF")
  expect(await $.tool.check({ tool: 'Bash', input: { command: allow } })).toMatchObject({ decision: 'allow' })
})

test('a statement whose file cannot be read, and any other command, is decided as it stands', async ($, on) => {
  const written = new Map<string, string>()
  stubs(on, written)
  const gone = ". '/c/Users/u/AppData/Local/Temp/claude-cmd/1-000000000000.sh'  # delivered as a file (9 chars): rm -rf /"
  expect(await $.tool.check({ tool: 'Bash', input: { command: gone } })).toMatchObject({ decision: 'allow' })
  expect(await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf build' } })).toMatchObject({ decision: 'deny' })
})

test('a short command without a hazard passes as written', async ($, on) => {
  const written = new Map<string, string>()
  stubs(on, written)
  const out = await $.tool.call({ tool: 'Bash', command: 'ls -la' })
  expect(out).toEqual({ result: { ran: 'ls -la' } })
  expect(written.size).toBe(0)
})

test('a command with a backslash pair is written to a file and sourced', async ($, on) => {
  const written = new Map<string, string>()
  stubs(on, written)
  const cmd = "python probe.py 'C:\\temp\\\\'"
  const out = await $.tool.call({ tool: 'Bash', command: cmd })
  expect(written.size).toBe(1)
  const [path, text] = [...written.entries()][0]
  expect(text).toBe(cmd + '\n')
  expect(path).toMatch(/\\Temp\\claude-cmd\\1790000000-[0-9a-f]{12}\.sh$/)
  expect(out.result.ran).toMatch(/^\. '\/c\/Users\/u\/AppData\/Local\/Temp\/claude-cmd\/1790000000-[0-9a-f]{12}\.sh'  # delivered as a file/)
})

test('a heredoc is rerouted, and a long command too', async ($, on) => {
  const written = new Map<string, string>()
  stubs(on, written)
  await $.tool.call({ tool: 'Bash', command: "cat <<'EOF'\nx\nEOF" })
  await $.tool.call({ tool: 'Bash', command: 'echo ' + 'a'.repeat(300) })
  expect(written.size).toBe(2)
})

test('a carriage return before a line feed is refused, with the hop named', async ($, on) => {
  const written = new Map<string, string>()
  stubs(on, written)
  const out = await $.tool.call({ tool: 'Bash', command: "printf 'a\r\nb'" })
  expect(out.deny).toMatch(/^Not run \(hop: shell parse\)\./)
  expect(written.size).toBe(0)
})

test('a rerouted command that asks how it was read is refused', async ($, on) => {
  const written = new Map<string, string>()
  stubs(on, written)
  const out = await $.tool.call({ tool: 'Bash', command: 'echo "$BASH_SOURCE" \\\\ x' })
  expect(out.deny).toMatch(/^Not run \(hop: host wrapper\)\. This command uses BASH_SOURCE/)
})

test('with INTACT_MOD_LOG=on each call leaves one record of counts, without the command text', async ($, on) => {
  const written = new Map<string, string>()
  stubs(on, written, { INTACT_MOD_LOG: 'on' })
  const cmd = "cat <<'EOF'\nsecret-text\nEOF"
  await $.tool.call({ tool: 'Bash', command: cmd })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  const logs = [...written.entries()].filter(([p]) => p.includes('\\intact-mod\\log\\session-1\\'))
  expect(logs.length).toBe(2)
  const recs = logs.map(([, text]) => JSON.parse(text)).sort((a, b) => b.length - a.length)
  expect(recs[0]).toMatchObject({ session: 'session-1', action: 'reroute', length: cmd.length, why: ['heredoc'] })
  expect(recs[1]).toMatchObject({ action: 'pass', length: 2, why: [] })
  expect(logs.some(([, text]) => text.includes('secret-text'))).toBe(false)
})

test('without INTACT_MOD_LOG no record is written', async ($, on) => {
  const written = new Map<string, string>()
  stubs(on, written)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect([...written.keys()].some(p => p.includes('intact-mod'))).toBe(false)
})

test('off the Windows launch, or switched off, every command passes', async ($, on) => {
  const written = new Map<string, string>()
  stubs(on, written, { INTACT_BASH_DELIVERY: 'off' })
  const out = await $.tool.call({ tool: 'Bash', command: "cat <<'EOF'\nx\nEOF" })
  expect(out).toEqual({ result: { ran: "cat <<'EOF'\nx\nEOF" } })
  expect(written.size).toBe(0)
})
