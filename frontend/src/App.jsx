import { useCallback, useEffect, useMemo, useState } from 'react'
import { BrowserRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom'

const API_URL = (import.meta.env.VITE_API_URL || 'https://colorwatcher.onrender.com') + '/data'
const POLL_INTERVAL = 30000  // 30 seconds

const STARTING_BALANCE = 6000

// ─── helpers ────────────────────────────────────────────────────────────────

function minutesDiff(d1, t1, d2, t2) {
  return (new Date(`${d2}T${t2}`) - new Date(`${d1}T${t1}`)) / 60000
}

function sideColor(text) {
  if (text.includes('❤️') || text.includes('🔴')) return 'red'
  if (text.includes('💚') || text.includes('🟢')) return 'green'
  return 'gray'
}

function fmt(n) {
  if (n >= 10000) return `${(n / 1000).toFixed(0)}K`
  if (n >= 1000)  return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

function to12h(time24) {
  const [hStr, mStr] = time24.split(':')
  let h = parseInt(hStr, 10)
  const ampm = h >= 12 ? 'PM' : 'AM'
  if (h === 0) h = 12
  else if (h > 12) h -= 12
  return `${h}:${mStr} ${ampm}`
}

function hourLabel(time24) {
  const h = parseInt(time24.slice(0, 2), 10)
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h
  return `${h12} ${ampm}`
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
}

function formatDateShort(dateStr) {
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

// ─── bet levels ──────────────────────────────────────────────────────────────
// Each level: game amount, label, stake key
const BET_LEVELS = [
  { amount: 900,   label: '9x'   },
  { amount: 2700,  label: '27x'  },
  { amount: 8100,  label: '81x'  },
  { amount: 24300, label: '243x' },
  { amount: 72900, label: '729x' },
]

const DEFAULT_STAKES = { '9x': 50, '27x': 150, '81x': 450, '243x': 1000, '729x': 0 }

// ─── P&L (stakes-aware) ───────────────────────────────────────────────────────
// P&L = stake at winning level - sum of stakes at all lower levels that were in chain
// Stop loss (729x) = -(sum of all stakes)

function chainPnL(chain, stakes = DEFAULT_STAKES) {
  const winAmt = chain[chain.length - 1].amount
  const maxAmt = Math.max(...chain.map(e => e.amount))

  if (maxAmt < 900) return null  // no bet placed

  // went above 729x (no limit) — all 5 levels lost
  if (maxAmt > 72900) {
    return -(BET_LEVELS.reduce((s, l) => s + (stakes[l.label] || 0), 0))
  }

  // walk each bet level; 729x included so win/loss at that level is calculated
  let lostSoFar = 0
  for (const lvl of BET_LEVELS) {
    if (maxAmt < lvl.amount) break
    if (winAmt === lvl.amount) {
      return (stakes[lvl.label] || 0) - lostSoFar
    }
    lostSoFar += (stakes[lvl.label] || 0)
  }
  return null
}

function outcomeLabel(chain) {
  const winAmt = chain[chain.length - 1].amount
  const maxAmt = Math.max(...chain.map(e => e.amount))
  if (maxAmt > 72900)   return 'no limit'
  if (maxAmt === 72900) return '729x'
  if (winAmt === 24300) return '243x'
  if (winAmt === 8100)  return '81x'
  if (winAmt === 2700)  return '27x'
  if (winAmt === 900)   return '9x'
  return '—'
}

function hitsSkipTrigger(maxAmt, trigger) {
  if (trigger === '243x')     return maxAmt >= 24300
  if (trigger === '729x')     return maxAmt >= 72900
  if (trigger === 'no_limit') return maxAmt > 72900
  return false
}

// ─── valid game amounts ───────────────────────────────────────────────────────
// Valid amounts follow the 3x sequence: 100, 300, 900, 2700, 8100, 24300, 72900, ...
// Anything else (e.g. 500000, 1000000, 2430072900) is garbage data to be ignored.

function isValidAmount(n) {
  if (n < 100 || !Number.isFinite(n)) return false
  if (n >= 72900) return true   // anything at/above stop-loss is a real game value
  let v = n
  while (v > 100) {
    if (v % 3 !== 0) return false
    v = v / 3
  }
  return v === 100
}

// ─── chain builder ───────────────────────────────────────────────────────────

function buildChains(entries) {
  const chains = []
  let cur = []

  for (const entry of entries) {
    if (!isValidAmount(entry.amount)) continue   // skip garbage data

    const e = { ...entry, side: sideColor(entry.text), result: 'LOSS' }
    const prev = cur[cur.length - 1]
    const gapBreak = prev && minutesDiff(prev.date, prev.time, e.date, e.time) > 10

    if ((e.amount === 100 || gapBreak) && cur.length > 0) {
      cur[cur.length - 1].result = 'WIN'
      chains.push([...cur])
      cur = []
    }
    cur.push(e)
  }

  if (cur.length > 0) {
    cur[cur.length - 1].result = 'WIN'
    chains.push(cur)
  }

  return chains
}

function getAllChainsSorted(results) {
  const byType = {}
  for (const e of results) {
    if (!byType[e.type]) byType[e.type] = []
    byType[e.type].push(e)
  }
  const all = []
  for (const entries of Object.values(byType)) {
    for (const chain of buildChains(entries)) all.push(chain)
  }
  all.sort((a, b) => new Date(`${a[0].date}T${a[0].time}`) - new Date(`${b[0].date}T${b[0].time}`))
  return all
}

function getChainsByDateAndHour(results) {
  const all = getAllChainsSorted(results)
  const dates = []
  const dateMap = {}
  for (const chain of all) {
    const date = chain[0].date
    const hourKey = chain[0].time.slice(0, 2)
    if (!dateMap[date]) {
      dateMap[date] = { date, label: formatDate(date), hours: [], hourMap: {} }
      dates.push(dateMap[date])
    }
    const d = dateMap[date]
    if (!d.hourMap[hourKey]) {
      d.hourMap[hourKey] = { key: hourKey, label: hourLabel(chain[0].time), chains: [] }
      d.hours.push(d.hourMap[hourKey])
    }
    d.hourMap[hourKey].chains.push(chain)
  }
  return { dates, all }
}

// ─── type tag ────────────────────────────────────────────────────────────────

const TYPE_TAG = {
  PARITY: 'bg-blue-100 text-blue-700',
  SAPRE:  'bg-violet-100 text-violet-700',
  BCONE:  'bg-amber-100 text-amber-700',
  EMERD:  'bg-rose-100 text-rose-700',
}

function TypeTag({ type }) {
  return (
    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${TYPE_TAG[type] || 'bg-gray-100 text-gray-600'}`}>
      {type}
    </span>
  )
}

// ─── chain chip (page 1) ──────────────────────────────────────────────────────

const LEVEL_STYLE = {
  100:   'bg-slate-100 text-slate-600 border-slate-200',
  300:   'bg-blue-100 text-blue-700 border-blue-200',
  900:   'bg-violet-100 text-violet-700 border-violet-200',
  2700:  'bg-yellow-100 text-yellow-700 border-yellow-200',
  8100:  'bg-orange-100 text-orange-700 border-orange-300',
  24300: 'bg-rose-200 text-rose-800 border-rose-400',
  72900: 'bg-red-300 text-red-900 border-red-500',
}

function ChainChip({ chain }) {
  const maxAmt  = Math.max(...chain.map(e => e.amount))
  const crossed = maxAmt >= 72900
  const at8100  = maxAmt === 8100
  const pnl     = chainPnL(chain)

  return (
    <div className={`flex flex-col gap-1 px-2.5 py-2 rounded-lg border shrink-0
      ${crossed ? 'border-rose-300 bg-rose-50' :
        at8100  ? 'border-orange-300 bg-orange-50' :
                  'border-gray-100 bg-white'}`}>
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] text-gray-500 font-medium">{to12h(chain[0].time)}</span>
        <TypeTag type={chain[0].type} />
        {pnl !== null && (
          <span className={`ml-auto text-[10px] font-bold px-1.5 py-0.5 rounded leading-none
            ${pnl > 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
            {pnl > 0 ? `+₹${pnl}` : `-₹${Math.abs(pnl)}`}
          </span>
        )}
      </div>
      <div className="flex items-center gap-0.5">
        {chain.map((e, i) => (
          <div key={i} className="flex items-center gap-0.5">
            <div className="flex flex-col items-center gap-0.5">
              <span className={`text-[10px] font-bold px-1 py-0.5 rounded border leading-none
                ${e.result === 'WIN'
                  ? 'bg-emerald-500 text-white border-emerald-600'
                  : LEVEL_STYLE[e.amount] || 'bg-gray-100 text-gray-600 border-gray-200'}`}>
                {fmt(e.amount)}
              </span>
              <span className="text-[9px] leading-none">{e.side === 'red' ? '🔴' : '🟢'}</span>
              <span className={`text-[9px] font-bold leading-none ${e.result === 'WIN' ? 'text-emerald-600' : 'text-red-400'}`}>
                {e.result === 'WIN' ? 'W' : 'L'}
              </span>
            </div>
            {i < chain.length - 1 && <span className="text-gray-200 text-[10px] pb-3">›</span>}
          </div>
        ))}
      </div>
    </div>
  )
}

function HourRow({ label, chains }) {
  return (
    <div className="flex items-start gap-3">
      <div className="w-14 shrink-0 pt-2 text-right">
        <span className="text-xs font-bold text-gray-400">{label}</span>
      </div>
      <div className="pt-3 shrink-0"><div className="w-px h-full bg-gray-200" /></div>
      <div className="flex flex-wrap gap-2 py-1">
        {chains.map((chain, i) => <ChainChip key={i} chain={chain} />)}
      </div>
    </div>
  )
}

// ─── PAGE 1: Timeline ────────────────────────────────────────────────────────

function TimelinePage({ dates, allChains }) {
  const crossed = allChains.filter(c => Math.max(...c.map(e => e.amount)) >= 72900)

  return (
    <div className="space-y-5">
      {crossed.length > 0 && (
        <div className="bg-rose-50 border border-rose-300 rounded-xl px-4 py-3">
          <p className="text-rose-800 font-bold text-xs mb-1.5">⚠️ {crossed.length} session(s) reached 72900 (stop loss)</p>
          {crossed.map((c, i) => {
            const max = Math.max(...c.map(e => e.amount))
            const win = c[c.length - 1]
            return (
              <div key={i} className="flex items-center gap-2 text-[11px] text-rose-700 mt-0.5">
                <TypeTag type={c[0].type} />
                <span>{c[0].date} {to12h(c[0].time)}</span>
                <span>→ reached <strong>{fmt(max)}</strong></span>
                <span>→ WIN <strong className="text-emerald-700">{fmt(win.amount)}</strong></span>
              </div>
            )
          })}
        </div>
      )}

      {dates.map(({ date, label, hours }) => (
        <div key={date} className="space-y-3">
          <div className="flex items-center gap-3">
            <div className="h-px flex-1 bg-gray-300" />
            <span className="text-xs font-bold text-gray-500 uppercase tracking-wide bg-gray-100 px-3 py-1 rounded-full border border-gray-300">
              📅 {label}
            </span>
            <div className="h-px flex-1 bg-gray-300" />
          </div>
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm px-5 py-4 space-y-4">
            {hours.map(({ key, label: hLabel, chains }) => (
              <HourRow key={key} label={hLabel} chains={chains} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── PAGE 2: Bet Table ───────────────────────────────────────────────────────

function to24h(h, ampm) {
  const n = parseInt(h, 10)
  if (isNaN(n) || n < 1 || n > 12) return null
  if (ampm === 'AM') return n === 12 ? 0 : n
  return n === 12 ? 12 : n + 12
}

function BetTablePage({ allChains }) {
  const currentMonth = new Date().toISOString().slice(0, 7)
  const [selectedMonth, setSelectedMonth] = useState(currentMonth)
  const [only729, setOnly729]             = useState(false)
  const [stakes, setStakes]               = useState(DEFAULT_STAKES)
  const [timeFrom, setTimeFrom]           = useState({ h: '', ampm: 'AM' })
  const [timeTo, setTimeTo]               = useState({ h: '', ampm: 'PM' })
  const [skipTrigger, setSkipTrigger]     = useState('off')   // 'off' | '243x' | '729x' | 'no_limit'
  const [skipCount, setSkipCount]         = useState(2)

  const updateStake = (label, val) => {
    const n = parseInt(val, 10)
    if (!isNaN(n) && n >= 0) setStakes(s => ({ ...s, [label]: n }))
  }

  const allRows = useMemo(() => {
    const fromH = to24h(timeFrom.h, timeFrom.ampm)
    const toH   = to24h(timeTo.h,   timeTo.ampm)

    const inTimeRange = (timeStr) => {
      const h = parseInt(timeStr.slice(0, 2), 10)
      if (fromH !== null && toH !== null)
        return fromH <= toH ? (h >= fromH && h <= toH) : (h >= fromH || h <= toH)
      if (fromH !== null) return h >= fromH
      if (toH   !== null) return h <= toH
      return true
    }

    // Pass 1: build raw rows (pnl only, no balance yet)
    const raw = allChains
      .filter(c => Math.max(...c.map(e => e.amount)) >= 900)
      .filter(c => inTimeRange(c[0].time))
      .map(chain => {
        const type     = chain[0].type
        const maxAmt   = Math.max(...chain.map(e => e.amount))
        const rowMonth = chain[0].date.slice(0, 7)
        const label    = outcomeLabel(chain)
        const pnl      = chainPnL(chain, stakes)
        return { date: chain[0].date, time: chain[0].time, type, outcome: label, maxAmt, pnl, month: rowMonth }
      })

    // Pass 2: mark skipped rows
    let skipRemaining = 0
    const withSkip = raw.map(row => {
      if (skipRemaining > 0) {
        skipRemaining--
        return { ...row, skipped: true }
      }
      if (skipTrigger !== 'off' && hitsSkipTrigger(row.maxAmt, skipTrigger)) {
        skipRemaining = skipCount
      }
      return { ...row, skipped: false }
    })

    // Pass 3: compute running balance (skipped rows don't affect bankroll)
    let balance  = STARTING_BALANCE
    let curMonth = null
    return withSkip.map(row => {
      if (row.month !== curMonth) {
        balance  = STARTING_BALANCE
        curMonth = row.month
      }
      if (!row.skipped) balance += (row.pnl ?? 0)
      return { ...row, balance }
    })
  }, [allChains, stakes, timeFrom, timeTo, skipTrigger, skipCount])

  const count729 = useMemo(() => allRows.filter(r => r.maxAmt >= 72900).length, [allRows])

  // month options from all rows
  const months = useMemo(() => {
    const seen = new Set()
    allRows.forEach(r => {
      const key = r.date.slice(0, 7)
      seen.add(key)
    })
    return ['all', ...Array.from(seen).sort()]
  }, [allRows])

  const rows = useMemo(() => {
    let filtered = selectedMonth === 'all' ? allRows : allRows.filter(r => r.month === selectedMonth)
    if (only729) filtered = filtered.filter(r => r.maxAmt >= 72900)
    return [...filtered].reverse()
  }, [allRows, selectedMonth, only729])

  const monthLabel = (key) => {
    if (key === 'all') return 'All Months'
    const d = new Date(key + '-01')
    return d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
  }

  const totalPnL = rows.filter(r => !r.skipped).reduce((s, r) => s + (r.pnl ?? 0), 0)

  // Per-month breakdown (used for both single-month card and all-months summary)
  const perMonthStats = useMemo(() => {
    return months.filter(m => m !== 'all').map(m => {
      const monthRows = allRows.filter(r => r.month === m)
      if (!monthRows.length) return null
      const closeBal = monthRows[monthRows.length - 1].balance
      const minBal   = Math.min(STARTING_BALANCE, ...monthRows.map(r => r.balance))
      const maxBal   = Math.max(STARTING_BALANCE, ...monthRows.map(r => r.balance))
      const netPnL   = closeBal - STARTING_BALANCE
      return { month: m, label: monthLabel(m), closeBal, minBal, maxBal, netPnL, sessions: monthRows.length }
    }).filter(Boolean)
  }, [allRows, months])

  const monthStats = useMemo(() => {
    if (selectedMonth === 'all') return null
    return perMonthStats.find(s => s.month === selectedMonth) || null
  }, [perMonthStats, selectedMonth])

  const allMonthsTotal = useMemo(() => {
    const totalPnL  = perMonthStats.reduce((s, m) => s + m.netPnL, 0)
    const bestMonth = perMonthStats.reduce((best, m) => (!best || m.netPnL > best.netPnL ? m : best), null)
    const worstMonth= perMonthStats.reduce((worst, m) => (!worst || m.netPnL < worst.netPnL ? m : worst), null)
    return { totalPnL, bestMonth, worstMonth, months: perMonthStats.length }
  }, [perMonthStats])

  return (
    <div className="space-y-4">
      {/* summary bar */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm px-5 py-3 flex flex-wrap gap-6 items-center">
        <div>
          <p className="text-xs text-gray-400">Starting Balance</p>
          <p className="text-lg font-bold text-gray-700">₹{STARTING_BALANCE.toLocaleString()}</p>
        </div>
        {selectedMonth === 'all' ? (
          <div>
            <p className="text-xs text-gray-400">Total Net P&L (All Months)</p>
            <p className={`text-lg font-bold ${allMonthsTotal.totalPnL >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
              {allMonthsTotal.totalPnL >= 0 ? '+' : ''}₹{allMonthsTotal.totalPnL.toLocaleString()}
            </p>
          </div>
        ) : (
          <div>
            <p className="text-xs text-gray-400">Month End Balance</p>
            <p className={`text-lg font-bold ${(monthStats?.netPnL ?? 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
              ₹{(monthStats?.closeBal ?? STARTING_BALANCE).toLocaleString()}
            </p>
          </div>
        )}
        <div>
          <p className="text-xs text-gray-400">729x+ Events</p>
          <p className="text-lg font-bold text-rose-600">{count729}</p>
        </div>
        <div className="ml-auto text-right">
          <p className="text-xs text-gray-400">Bet Sessions</p>
          <p className="text-lg font-bold text-gray-700">{rows.length}</p>
        </div>
        {/* month filter */}
        {/* stake inputs */}
        <div className="w-full border-t border-gray-100 pt-3 mt-1">
          <p className="text-xs text-gray-400 font-medium mb-2">Bet Stakes (editable)</p>
          <div className="flex flex-wrap gap-3">
            {BET_LEVELS.map(lvl => (
              <div key={lvl.label} className="flex items-center gap-1.5">
                <span className="text-xs font-semibold text-gray-600 w-10">{lvl.label}</span>
                <div className="flex items-center border border-gray-200 rounded-lg overflow-hidden">
                  <span className="text-xs text-gray-400 px-2 bg-gray-50 border-r border-gray-200">₹</span>
                  <input
                    type="number"
                    min="0"
                    value={stakes[lvl.label]}
                    onChange={e => updateStake(lvl.label, e.target.value)}
                    className="text-xs font-bold text-gray-800 w-16 px-2 py-1 outline-none"
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="w-full border-t border-gray-100 pt-3 flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-400 font-medium">Filter by month:</span>
          {months.map(m => (
            <button key={m}
              onClick={() => setSelectedMonth(m)}
              className={`text-xs px-3 py-1 rounded-full border transition-colors
                ${selectedMonth === m
                  ? 'bg-slate-700 text-white border-slate-700'
                  : 'bg-white text-gray-600 border-gray-200 hover:border-slate-400'}`}>
              {monthLabel(m)}
            </button>
          ))}
          <button
            onClick={() => setOnly729(v => !v)}
            className={`text-xs px-3 py-1 rounded-full border font-semibold transition-colors ml-2
              ${only729
                ? 'bg-rose-600 text-white border-rose-600'
                : 'bg-white text-rose-600 border-rose-300 hover:border-rose-500'}`}>
            729x+ only ({count729})
          </button>
        </div>

        <div className="w-full border-t border-gray-100 pt-3 flex items-center gap-3 flex-wrap">
          <span className="text-xs text-gray-400 font-medium">Time range:</span>
          {[
            { label: 'From', val: timeFrom, set: setTimeFrom },
            { label: 'To',   val: timeTo,   set: setTimeTo   },
          ].map(({ label, val, set }) => (
            <div key={label} className="flex items-center gap-1.5">
              <span className="text-xs text-gray-500">{label}</span>
              <div className="flex items-center border border-gray-200 rounded-lg overflow-hidden">
                <input
                  type="number" min="1" max="12" placeholder="hh"
                  value={val.h}
                  onChange={e => set(v => ({ ...v, h: e.target.value }))}
                  className="text-sm font-bold text-gray-800 w-14 px-2 py-1.5 outline-none text-center"
                />
                <select
                  value={val.ampm}
                  onChange={e => set(v => ({ ...v, ampm: e.target.value }))}
                  className="text-sm text-gray-600 bg-gray-50 border-l border-gray-200 px-2 py-1.5 outline-none">
                  <option>AM</option>
                  <option>PM</option>
                </select>
              </div>
            </div>
          ))}
          {(timeFrom.h || timeTo.h) && (
            <button
              onClick={() => { setTimeFrom({ h: '', ampm: 'AM' }); setTimeTo({ h: '', ampm: 'PM' }) }}
              className="text-xs text-gray-400 hover:text-gray-600 underline">
              clear
            </button>
          )}
        </div>

        <div className="w-full border-t border-gray-100 pt-3 flex items-center gap-3 flex-wrap">
          <span className="text-xs text-gray-400 font-medium">Skip sessions after:</span>
          {[
            { value: 'off',      label: 'Off' },
            { value: '243x',     label: '243x' },
            { value: '729x',     label: '729x' },
            { value: 'no_limit', label: 'No Limit' },
          ].map(opt => (
            <button key={opt.value}
              onClick={() => setSkipTrigger(opt.value)}
              className={`text-xs px-3 py-1 rounded-full border transition-colors
                ${skipTrigger === opt.value
                  ? 'bg-amber-500 text-white border-amber-500'
                  : 'bg-white text-gray-600 border-gray-200 hover:border-amber-400'}`}>
              {opt.label}
            </button>
          ))}
          {skipTrigger !== 'off' && (
            <div className="flex items-center gap-2 ml-1">
              <span className="text-xs text-gray-400">skip next</span>
              {[2, 3, 4, 5].map(n => (
                <button key={n}
                  onClick={() => setSkipCount(n)}
                  className={`text-xs w-7 h-7 rounded-full border font-bold transition-colors
                    ${skipCount === n
                      ? 'bg-amber-500 text-white border-amber-500'
                      : 'bg-white text-gray-600 border-gray-200 hover:border-amber-400'}`}>
                  {n}
                </button>
              ))}
              <span className="text-xs text-gray-400">sessions</span>
            </div>
          )}
        </div>
      </div>

      {/* all months summary card */}
      {selectedMonth === 'all' && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm px-5 py-4 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">📊 All Months Summary</p>
            <div className="flex gap-6 text-xs">
              <span className="text-gray-400">{allMonthsTotal.months} months · ₹{STARTING_BALANCE.toLocaleString()} each</span>
              {allMonthsTotal.bestMonth && (
                <span className="text-emerald-600 font-semibold">
                  Best: {allMonthsTotal.bestMonth.label} ({allMonthsTotal.bestMonth.netPnL >= 0 ? '+' : ''}₹{allMonthsTotal.bestMonth.netPnL.toLocaleString()})
                </span>
              )}
              {allMonthsTotal.worstMonth && (
                <span className="text-red-500 font-semibold">
                  Worst: {allMonthsTotal.worstMonth.label} ({allMonthsTotal.worstMonth.netPnL >= 0 ? '+' : ''}₹{allMonthsTotal.worstMonth.netPnL.toLocaleString()})
                </span>
              )}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-400 border-b border-gray-100">
                  <th className="text-left py-1.5 pr-4 font-medium">Month</th>
                  <th className="text-right py-1.5 px-4 font-medium">Open</th>
                  <th className="text-right py-1.5 px-4 font-medium">Lowest</th>
                  <th className="text-right py-1.5 px-4 font-medium">Highest</th>
                  <th className="text-right py-1.5 px-4 font-medium">Close</th>
                  <th className="text-right py-1.5 pl-4 font-medium">Net P&L</th>
                </tr>
              </thead>
              <tbody>
                {perMonthStats.map(s => (
                  <tr key={s.month} className="border-b border-gray-50 hover:bg-gray-50 cursor-pointer"
                    onClick={() => setSelectedMonth(s.month)}>
                    <td className="py-1.5 pr-4 font-medium text-gray-700">{s.label}</td>
                    <td className="py-1.5 px-4 text-right text-gray-500">₹{STARTING_BALANCE.toLocaleString()}</td>
                    <td className="py-1.5 px-4 text-right text-red-400">₹{s.minBal.toLocaleString()}</td>
                    <td className="py-1.5 px-4 text-right text-emerald-600">₹{s.maxBal.toLocaleString()}</td>
                    <td className="py-1.5 px-4 text-right text-gray-700 font-medium">₹{s.closeBal.toLocaleString()}</td>
                    <td className={`py-1.5 pl-4 text-right font-bold ${s.netPnL >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                      {s.netPnL >= 0 ? '+' : ''}₹{s.netPnL.toLocaleString()}
                    </td>
                  </tr>
                ))}
                <tr className="bg-gray-50 font-bold">
                  <td className="py-2 pr-4 text-gray-700">Total</td>
                  <td className="py-2 px-4 text-right text-gray-500">₹{(STARTING_BALANCE * allMonthsTotal.months).toLocaleString()}</td>
                  <td className="py-2 px-4" />
                  <td className="py-2 px-4" />
                  <td className="py-2 px-4" />
                  <td className={`py-2 pl-4 text-right ${allMonthsTotal.totalPnL >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                    {allMonthsTotal.totalPnL >= 0 ? '+' : ''}₹{allMonthsTotal.totalPnL.toLocaleString()}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* month stats card */}
      {monthStats && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm px-5 py-4">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
            📅 {monthLabel(selectedMonth)} — Balance Stats
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
            <div>
              <p className="text-[11px] text-gray-400">Opening Balance</p>
              <p className="text-base font-bold text-gray-700">₹{STARTING_BALANCE.toLocaleString()}</p>
            </div>
            <div>
              <p className="text-[11px] text-gray-400">Lowest Reached</p>
              <p className="text-base font-bold text-red-500">₹{monthStats.minBal.toLocaleString()}</p>
            </div>
            <div>
              <p className="text-[11px] text-gray-400">Highest Reached</p>
              <p className="text-base font-bold text-emerald-600">₹{monthStats.maxBal.toLocaleString()}</p>
            </div>
            <div>
              <p className="text-[11px] text-gray-400">Closing Balance</p>
              <p className="text-base font-bold text-gray-700">₹{monthStats.closeBal.toLocaleString()}</p>
            </div>
            <div>
              <p className="text-[11px] text-gray-400">Month Net P&L</p>
              <p className={`text-base font-bold ${monthStats.netPnL >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                {monthStats.netPnL >= 0 ? '+' : ''}₹{monthStats.netPnL.toLocaleString()}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* table */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-700 text-white">
                <th className="px-4 py-3 text-left font-semibold text-xs">Date</th>
                <th className="px-4 py-3 text-left font-semibold text-xs">Time</th>
                <th className="px-4 py-3 text-left font-semibold text-xs">Game</th>
                <th className="px-4 py-3 text-left font-semibold text-xs">Outcome</th>
                {BET_LEVELS.map(lvl => (
                  <th key={lvl.label} className="px-4 py-3 text-right font-semibold text-xs">
                    {lvl.label} Stake
                  </th>
                ))}
                <th className="px-4 py-3 text-right font-semibold text-xs">Net P&L</th>
                <th className="px-4 py-3 text-right font-semibold text-xs">Running Bankroll</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => {
                const highlight = row.maxAmt >= 72900
                const is243     = row.outcome === '243x'
                if (row.skipped) return (
                  <tr key={i} className="border-t border-gray-100 opacity-40 bg-gray-50">
                    <td className="px-4 py-2.5 font-medium text-xs whitespace-nowrap text-gray-400">
                      {formatDateShort(row.date)}
                    </td>
                    <td className="px-4 py-2.5 text-xs whitespace-nowrap text-gray-400">
                      {to12h(row.time)}
                    </td>
                    <td className="px-4 py-2.5">
                      <TypeTag type={row.type} />
                    </td>
                    <td className="px-4 py-2.5 text-xs font-semibold text-gray-400">
                      {row.outcome}
                    </td>
                    {BET_LEVELS.map(lvl => (
                      <td key={lvl.label} className="px-4 py-2.5 text-xs text-right text-gray-300">—</td>
                    ))}
                    <td className="px-4 py-2.5 text-xs text-right">
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-gray-200 text-gray-500 uppercase tracking-wide">SKIP</span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-right text-gray-400 font-bold">
                      ₹{row.balance.toLocaleString()}
                    </td>
                  </tr>
                )
                return (
                  <tr key={i}
                    className={`border-t border-gray-100 transition-colors
                      ${highlight
                        ? 'bg-rose-50 text-rose-700'
                        : is243
                        ? 'bg-yellow-50'
                        : i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}`}>
                    <td className="px-4 py-2.5 font-medium text-xs whitespace-nowrap">
                      {formatDateShort(row.date)}
                    </td>
                    <td className="px-4 py-2.5 text-xs whitespace-nowrap">
                      {to12h(row.time)}
                    </td>
                    <td className="px-4 py-2.5">
                      <TypeTag type={row.type} />
                    </td>
                    <td className={`px-4 py-2.5 text-xs font-semibold
                      ${highlight ? 'text-rose-700' : 'text-gray-700'}`}>
                      {row.outcome}
                    </td>
                    {BET_LEVELS.map(lvl => (
                      <td key={lvl.label} className="px-4 py-2.5 text-xs text-right text-gray-400">
                        {row.maxAmt < lvl.amount ? '₹0' : `₹${stakes[lvl.label]}`}
                      </td>
                    ))}
                    <td className={`px-4 py-2.5 text-xs text-right font-bold
                      ${row.pnl > 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                      {row.pnl > 0 ? `+₹${row.pnl}` : `-₹${Math.abs(row.pnl)}`}
                    </td>
                    <td className={`px-4 py-2.5 text-xs text-right font-bold
                      ${highlight ? 'text-rose-700' : 'text-gray-800'}`}>
                      ₹{row.balance.toLocaleString()}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// ─── Data loader (shared across routes) ──────────────────────────────────────

function useData() {
  const [data, setData]               = useState(null)
  const [lastFetched, setLastFetched] = useState(null)
  const [error, setError]             = useState(false)

  const fetchData = useCallback(() => {
    fetch(API_URL)
      .then(r => { if (!r.ok) throw new Error(); return r.json() })
      .then(json => { setData(json); setLastFetched(new Date()); setError(false) })
      .catch(() => {
        fetch('/data.json')
          .then(r => r.json())
          .then(json => { setData({ ...json, live: false }); setLastFetched(new Date()); setError(false) })
          .catch(() => setError(true))
      })
  }, [])

  useEffect(() => {
    fetchData()
    const id = setInterval(fetchData, POLL_INTERVAL)
    return () => clearInterval(id)
  }, [fetchData])

  return { data, lastFetched, error }
}

// ─── Layout (header + nav shared by all pages) ───────────────────────────────

function Layout({ data, lastFetched, children }) {
  const { all } = useMemo(
    () => data ? getChainsByDateAndHour(data.results) : { dates: [], all: [] },
    [data]
  )

  const lastUpdatedStr = lastFetched
    ? lastFetched.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : null

  const navCls = ({ isActive }) =>
    `px-4 py-1.5 rounded-md text-xs font-semibold transition-colors ${
      isActive ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
    }`

  return (
    <div className="min-h-screen bg-gray-100">
      <div className="max-w-7xl mx-auto px-4 py-6">

        <div className="bg-white rounded-xl border border-gray-200 shadow-sm px-5 py-4 mb-5">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-bold text-gray-900">{data.group}</h1>
                {data.live
                  ? <span className="flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 border border-emerald-200">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse inline-block" />
                      LIVE
                    </span>
                  : <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 border border-gray-200">
                      OFFLINE
                    </span>
                }
              </div>
              <div className="flex flex-wrap gap-3 mt-1 text-xs text-gray-500">
                <span>💬 {data.messages_scanned} messages</span>
                <span>🎯 {data.matches} matches</span>
                <span>📊 {all.length} sessions</span>
                {lastUpdatedStr && <span className="text-gray-400">↻ {lastUpdatedStr}</span>}
              </div>
            </div>
            <div className="flex gap-1 bg-gray-100 p-1 rounded-lg">
              <NavLink to="/table"    className={navCls}>Bet Table</NavLink>
              <NavLink to="/timeline" className={navCls}>Timeline</NavLink>
            </div>
          </div>
          <div className="flex gap-2 mt-2">
            {data.target_types.map(t => <TypeTag key={t} type={t} />)}
          </div>
        </div>

        {children}
      </div>
    </div>
  )
}

// ─── App ─────────────────────────────────────────────────────────────────────

export default function App() {
  const { data, lastFetched, error } = useData()

  if (!data) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm px-8 py-6 text-center">
          {error
            ? <>
                <p className="text-red-600 font-bold text-sm mb-1">Cannot connect to live listener</p>
                <p className="text-gray-500 text-xs">Make sure <code className="bg-gray-100 px-1 rounded">live_listener.py</code> is running</p>
                <p className="text-gray-400 text-xs mt-1">Retrying every 30 seconds…</p>
              </>
            : <p className="text-gray-500 text-sm">Loading data…</p>
          }
        </div>
      </div>
    )
  }

  const { dates, all } = getChainsByDateAndHour(data.results)

  return (
    <BrowserRouter>
      <Layout data={data} lastFetched={lastFetched}>
        <Routes>
          <Route path="/"         element={<Navigate to="/table" replace />} />
          <Route path="/table"    element={<BetTablePage allChains={all} />} />
          <Route path="/timeline" element={<TimelinePage dates={dates} allChains={all} />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  )
}
