import { DEFAULT_LOSSES_PATH, DEFAULT_MANIFEST_PATH, diffLossBudgets, evaluateManifest, formatSummary, loadManifest, readLossBudget, writeLossBudget } from './index.js'

async function main(): Promise<void> {
  const updateLosses = process.argv.includes('--update-losses')
  const manifestPath = DEFAULT_MANIFEST_PATH
  const lossesPath = DEFAULT_LOSSES_PATH

  const manifest = await loadManifest(manifestPath)
  const summary = await evaluateManifest(manifest, { manifestPath })
  const baseline = await readLossBudget(lossesPath)
  const current = { losses: summary.losses }
  const diff = diffLossBudgets(current, baseline)

  console.log(formatSummary(summary))
  console.log('')
  console.log(`baseline losses: ${baseline.losses.length}`)
  console.log(`current losses: ${current.losses.length}`)
  console.log(`new losses: ${diff.newLosses.length}`)
  console.log(`resolved losses: ${diff.resolvedLosses.length}`)

  if (updateLosses) {
    await writeLossBudget(lossesPath, current)
    console.log(`updated ${lossesPath}`)
    return
  }

  if (summary.exactRecallViolations.length > 0) {
    console.error('exact recall floor regressed')
    process.exitCode = 1
  }

  if (diff.newLosses.length > 0) {
    console.error('loss budget regressed')
    for (const loss of diff.newLosses) {
      console.error(`  - ${loss.queryId}: ${loss.axes.join(', ')}`)
    }
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
