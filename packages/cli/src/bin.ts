const command = process.argv[2]

const run = command === 'mcp'
  ? import('./mcp-shim.js').then(({ runMcpShim }) => runMcpShim())
  : command === 'daemon'
    ? import('./daemon.js').then(({ runDaemon }) => runDaemon())
    : import('./program.js').then(({ runCli }) => runCli())

run.catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
