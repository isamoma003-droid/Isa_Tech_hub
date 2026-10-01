import { useLayoutEffect, useRef, useState } from 'react';
import { compact, formatDay, formatKes, formatNumber } from '../utils/format.js';

function useWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

// 0 / 1,000 / 2,000 … : a clean top for the axis and evenly spaced ticks.
function niceTicks(max, count = 4) {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw);
  return Array.from({ length: Math.ceil(max / step) + 1 }, (_, i) => i * step);
}

// A column with a 4px rounded data-end and a square foot on the baseline.
function columnPath(x, y, w, h) {
  const r = Math.min(4, w / 2, h);
  const base = y + h;
  return `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${base}Z`;
}

/** Money received per Kenyan day. One series, so no legend: the card title names it. */
export function DailyChart({ days }) {
  const [ref, width] = useWidth();
  const [active, setActive] = useState(null);
  const height = 220;
  const margin = { top: 22, right: 8, bottom: 26, left: 52 };
  const innerW = Math.max(0, width - margin.left - margin.right);
  const innerH = height - margin.top - margin.bottom;

  const ticks = niceTicks(Math.max(...days.map((d) => d.amount)));
  const top = ticks.at(-1);
  const band = days.length ? innerW / days.length : 0;
  const barW = Math.max(2, Math.min(24, band - 2)); // ≤24px, and a 2px surface gap between neighbours
  const y = (value) => innerH - (value / top) * innerH;

  // Label sparingly: the best day and today.
  const best = days.reduce((bestIndex, d, i) => (d.amount > days[bestIndex].amount ? i : bestIndex), 0);
  const labelled = new Set([best, days.length - 1].filter((i) => days[i]?.amount > 0));
  const showTick = (i) => i === days.length - 1 || (days.length - 1 - i) % 7 === 0;

  const move = (delta) => setActive((current) => Math.min(days.length - 1, Math.max(0, (current ?? days.length) + delta)));
  const point = active !== null ? days[active] : null;

  return (
    <div className="chart" ref={ref}>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label="Money received per day over the last 30 days. Use the arrow keys to read each day."
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') move(-1);
            else if (event.key === 'ArrowRight') move(1);
            else if (event.key === 'Escape') setActive(null);
            else return;
            event.preventDefault();
          }}
          onBlur={() => setActive(null)}
          onPointerLeave={() => setActive(null)}
        >
          <g transform={`translate(${margin.left},${margin.top})`}>
            {ticks.map((tick) => (
              <g key={tick} transform={`translate(0,${y(tick)})`}>
                <line x2={innerW} className={tick === 0 ? 'axis-line' : 'grid-line'} />
                <text x={-8} dy="0.32em" textAnchor="end" className="tick">
                  {compact(tick)}
                </text>
              </g>
            ))}
            {days.map((d, i) => {
              const x = i * band + (band - barW) / 2;
              const h = innerH - y(d.amount);
              return (
                <g key={d.date}>
                  {d.amount > 0 && (
                    <path d={columnPath(x, y(d.amount), barW, Math.max(h, 1))} className={`bar ${active === i ? 'bar-active' : ''}`} />
                  )}
                  {labelled.has(i) && (
                    <text x={x + barW / 2} y={y(d.amount) - 6} textAnchor="middle" className="bar-label">
                      {compact(d.amount)}
                    </text>
                  )}
                  {showTick(i) && (
                    <text x={x + barW / 2} y={innerH + 18} textAnchor="middle" className="tick">
                      {i === days.length - 1 ? 'Today' : formatDay(d.date)}
                    </text>
                  )}
                  {/* The whole column of the band is the hover target, not just the painted bar. */}
                  <rect x={i * band} y={0} width={band} height={innerH} fill="transparent" onPointerEnter={() => setActive(i)} />
                </g>
              );
            })}
          </g>
        </svg>
      )}
      {point && (
        <div
          className="tooltip"
          style={{
            left: Math.min(Math.max(margin.left + active * band + band / 2, 70), width - 70),
            top: Math.max(margin.top + y(point.amount) - 12, 0),
          }}
        >
          <strong>{formatKes(point.amount)}</strong>
          <span>
            {formatDay(point.date, { weekday: 'short', day: 'numeric', month: 'short' })} · {point.count} payment{point.count === 1 ? '' : 's'}
          </span>
        </div>
      )}
      <details className="table-view">
        <summary>Show as a table</summary>
        <table className="table compact-table">
          <thead>
            <tr>
              <th>Day</th>
              <th className="num">Payments</th>
              <th className="num">Received</th>
            </tr>
          </thead>
          <tbody>
            {[...days].reverse().map((d) => (
              <tr key={d.date}>
                <td>{formatDay(d.date, { weekday: 'short', day: 'numeric', month: 'short' })}</td>
                <td className="num">{formatNumber(d.count)}</td>
                <td className="num">{formatKes(d.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

/** Money per platform: one bar each, value at the tip, so every number is visible without hovering. */
export function PlatformBars({ rows }) {
  const max = Math.max(1, ...rows.map((row) => row.amount));
  return (
    <ul className="hbars">
      {rows.map((row) => (
        <li key={row.platform.id}>
          <span className="hbar-name">{row.platform.name}</span>
          <span className="hbar-track">
            <span className="hbar-fill" style={{ width: `${Math.max(0.5, (row.amount / max) * 100)}%` }} />
          </span>
          <span className="hbar-value">
            {formatKes(row.amount)}
            <small>
              {formatNumber(row.count)} payment{row.count === 1 ? '' : 's'}
            </small>
          </span>
        </li>
      ))}
    </ul>
  );
}
