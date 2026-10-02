import { columnChartGeometry, type ChartPoint } from './graphique.ts'

/**
 * Histogramme mensuel, en SVG, sans bibliothèque ni script : une seule série,
 * des barres de 24 px au plus, arrondies du côté de la valeur et carrées sur
 * la ligne de base, une grille discrète.
 *
 * Le graphique illustre, il ne remplace rien : chaque valeur est dans le
 * tableau qui l'accompagne (`tableId`), auquel la description renvoie. Une
 * seule couleur, le bleu foncé de la charte — elle désigne la série, elle ne
 * juge pas : un mois faible n'est pas peint autrement qu'un mois fort.
 */
export function MonthlyColumnChart({
  id,
  title,
  summary,
  points,
  formatTick,
  minMax,
}: {
  id: string
  title: string
  /** Ce que le graphique montre, en une phrase, pour les lecteurs d'écran. */
  summary: string
  points: readonly ChartPoint[]
  formatTick: (value: number) => string
  /** Haut d'échelle minimal : 1000 pour un taux en dixièmes de pour cent. */
  minMax?: number
}) {
  const geometry = columnChartGeometry(points, { minMax })

  return (
    <figure className="flex flex-col gap-2">
      <figcaption id={`${id}-titre`} className="text-sm font-medium">
        {title}
      </figcaption>
      <svg
        viewBox={`0 0 ${geometry.width} ${geometry.height}`}
        role="img"
        aria-labelledby={`${id}-titre ${id}-resume`}
        className="h-auto w-full max-w-3xl"
      >
        <desc id={`${id}-resume`}>{summary}</desc>
        {geometry.ticks.map((tick) => (
          <g key={tick.value}>
            <line
              x1={geometry.plotLeft}
              x2={geometry.width}
              y1={tick.y}
              y2={tick.y}
              className={tick.value === 0 ? 'stroke-muted-foreground' : 'stroke-border'}
              strokeWidth={1}
            />
            <text
              x={geometry.plotLeft - 8}
              y={tick.y}
              textAnchor="end"
              dominantBaseline="middle"
              className="fill-muted-foreground tabular"
              fontSize={11}
            >
              {formatTick(tick.value)}
            </text>
          </g>
        ))}
        {geometry.bars.map((bar) => (
          <g key={bar.point.key}>
            {/* Infobulle native au survol ; la valeur est aussi dans le tableau. */}
            <title>{`${bar.point.label} : ${bar.point.display}`}</title>
            {/* Cible de survol plus large que la barre. */}
            <rect x={bar.slotX} y={0} width={bar.slotWidth} height={geometry.baseline} fill="transparent" />
            {bar.path && <path d={bar.path} className="fill-brand-fonce" />}
            <text
              x={bar.centerX}
              y={geometry.height - 18}
              textAnchor="middle"
              className="fill-muted-foreground"
              fontSize={11}
            >
              {bar.point.shortLabel}
            </text>
            {bar.point.year && (
              <text
                x={bar.centerX}
                y={geometry.height - 4}
                textAnchor="middle"
                className="fill-muted-foreground tabular"
                fontSize={10}
              >
                {bar.point.year}
              </text>
            )}
          </g>
        ))}
      </svg>
    </figure>
  )
}
