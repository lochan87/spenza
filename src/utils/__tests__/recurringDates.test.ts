import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseRecurringDate } from '../recurringDates.ts'

describe('Recurring UTC calendar policy across browser timezones', () => {
  for (const timezone of ['UTC', 'Asia/Kolkata', 'America/Los_Angeles']) {
    it(`round-trips dates and confirms identical stored occurrences in ${timezone}`, () => {
      const env: NodeJS.ProcessEnv = { ...process.env, TZ: timezone }
      // Do not inherit Node's worker marker: the nested --test must start its
      // own runner rather than being mistaken for this runner's worker.
      delete env.NODE_TEST_CONTEXT
      const utilityUrl = new URL('../recurringDates.ts', import.meta.url).href
      const dateChecks = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
        import assert from 'node:assert/strict'
        import { recurringDateKey, parseRecurringDate, formatRecurringDate, recurringDaysUntil } from ${JSON.stringify(utilityUrl)}
        // Prove the process really uses the requested timezone, including DST.
        const expectedOffsets = { UTC: [0, 0], 'Asia/Kolkata': [-330, -330], 'America/Los_Angeles': [480, 420] }
        assert.deepEqual([new Date('2026-01-01Z').getTimezoneOffset(), new Date('2026-07-01Z').getTimezoneOffset()], expectedOffsets[process.env.TZ])
        for (const key of ['2026-03-01', '2026-03-08', '2026-11-01', '2024-02-29', '2026-12-31']) {
          const date = parseRecurringDate(key)
          assert.equal(date.toISOString(), key + 'T00:00:00.000Z')
          assert.equal(recurringDateKey(date), key)
          assert.equal(parseRecurringDate(recurringDateKey(date)).getTime(), date.getTime())
        }
        assert.equal(formatRecurringDate(parseRecurringDate('2026-03-01')), '1 Mar 2026')
        assert.equal(formatRecurringDate(parseRecurringDate('2026-03-01'), false), '1 Mar')
        const legacy = new Date('2026-02-28T18:30:00.123Z')
        assert.equal(recurringDateKey(legacy), '2026-02-28')
        assert.equal(formatRecurringDate(legacy), '28 Feb 2026')
        assert.equal(recurringDaysUntil(new Date('2026-03-08T20:00:00Z'), new Date('2026-03-08T01:00:00Z')), 0)
        assert.equal(recurringDaysUntil(new Date('2026-03-09T00:00:00Z'), new Date('2026-03-08T23:00:00Z')), 1)
      `], { env, encoding: 'utf8', timeout: 60_000 })
      assert.equal(dateChecks.status, 0, `${dateChecks.error ?? ''}\n${dateChecks.stdout}\n${dateChecks.stderr}`)

      // The production service and its optimistic-transaction double run in a
      // separate process for each TZ, including duplicate/retry/rollback cases.
      const serviceChecks = spawnSync(process.execPath, [
        '--experimental-strip-types', '--test',
        fileURLToPath(new URL('../../services/__tests__/recurringConfirmation.test.ts', import.meta.url)),
      ], { env, encoding: 'utf8', timeout: 60_000 })
      assert.equal(serviceChecks.status, 0, `${serviceChecks.error ?? ''}\n${serviceChecks.stdout}\n${serviceChecks.stderr}`)
      assert.match(serviceChecks.stdout, /(?:# |ℹ )pass 31\b/)
    })
  }

  it('rejects invalid calendar dates instead of silently rolling into another month', () => {
    for (const value of ['2026-02-29', '2026-04-31', '2026-13-01', 'invalid', '2026-1-1']) {
      assert.throws(() => parseRecurringDate(value), /valid recurring date/)
    }
  })
})
