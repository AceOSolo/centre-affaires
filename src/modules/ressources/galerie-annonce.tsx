'use client'

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'

import Image from 'next/image'

import {
  ChevronLeftIcon,
  ChevronRightIcon,
  PauseIcon,
  PlayIcon,
} from '../../components/ui/icons.tsx'

export type GalerieItem = {
  id: string
  kind: 'photo' | 'video'
  src: string
  alt: string
}

/** Assez long pour regarder une photo, assez court pour donner envie de la suivante. */
const ROTATION_MS = 6000

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'
const subscribeMotion = (onChange: () => void) => {
  const query = window.matchMedia(REDUCED_MOTION)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}
const readMotionAllowed = () => !window.matchMedia(REDUCED_MOTION).matches

/**
 * Galerie d'une annonce (ADR 073) : photos et vidéos qui défilent en tête de
 * la page publique.
 *
 * Le défilement suit le motif « carrousel » de l'APG du W3C (WCAG 2.2.2) :
 * - il ne démarre pas si le visiteur a demandé moins d'animations ;
 * - il marque une pause au survol, au focus clavier, hors de l'écran, onglet
 *   caché, et tant qu'une vidéo joue ;
 * - il s'arrête pour de bon dès que le visiteur navigue lui-même (flèches,
 *   vignettes, glisser du doigt, clavier) ou appuie sur « Pause » ;
 * - les changements ne sont annoncés aux lecteurs d'écran que lorsqu'il est
 *   arrêté, pour ne pas les couper toutes les six secondes.
 *
 * Le glissement est celui du navigateur (`scroll-snap`) : naturel au doigt,
 * sans bibliothèque.
 */
export function GalerieAnnonce({ items, title }: { items: GalerieItem[]; title: string }) {
  const regionId = useId()
  const trackRef = useRef<HTMLDivElement>(null)
  const regionRef = useRef<HTMLElement>(null)
  const [current, setCurrent] = useState(0)
  // Côté serveur, rien ne bouge : le réglage du visiteur n'est lu qu'au navigateur.
  const motionAllowed = useSyncExternalStore(subscribeMotion, readMotionAllowed, () => false)
  /** Arrêté par le visiteur : bouton « Pause », ou navigation de sa main. */
  const [stopped, setStopped] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [visible, setVisible] = useState(true)
  const [videoPlaying, setVideoPlaying] = useState(false)
  const count = items.length
  const rotating = motionAllowed && count > 1 && !stopped

  // Hors de l'écran ou onglet caché : rien ne défile pour personne.
  useEffect(() => {
    const region = regionRef.current
    if (!region) return
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      threshold: 0.4,
    })
    observer.observe(region)
    const onVisibility = () => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      observer.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  const goTo = useCallback(
    (index: number) => {
      const track = trackRef.current
      if (!track || count === 0) return
      const target = (index + count) % count
      track.scrollTo({
        left: target * track.clientWidth,
        behavior: motionAllowed ? 'smooth' : 'auto',
      })
    },
    [count, motionAllowed],
  )

  /** Le visiteur prend la main : le défilement automatique s'arrête pour de bon. */
  const takeOver = useCallback(() => setStopped(true), [])

  const paused = !rotating || hovered || focused || !visible || videoPlaying
  useEffect(() => {
    if (paused || count < 2) return
    const timer = window.setTimeout(() => goTo(current + 1), ROTATION_MS)
    return () => window.clearTimeout(timer)
  }, [paused, current, count, goTo])

  // L'image affichée se déduit de la position : le doigt, la souris et le
  // défilement automatique passent tous par le même chemin.
  useEffect(() => {
    const track = trackRef.current
    if (!track) return
    let frame = 0
    const onScroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const index = Math.round(track.scrollLeft / Math.max(track.clientWidth, 1))
        setCurrent(Math.min(Math.max(index, 0), count - 1))
      })
    }
    track.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      track.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(frame)
    }
  }, [count])

  // Une vidéo qui sort de l'écran s'arrête : on ne l'entend pas jouer ailleurs.
  useEffect(() => {
    trackRef.current?.querySelectorAll('video').forEach((video, index) => {
      if (index !== current && !video.paused) video.pause()
    })
  }, [current])

  if (count === 0) return null
  const item = items[current]
  const label = (index: number) =>
    `${items[index].kind === 'video' ? 'Vidéo' : 'Photo'} ${index + 1} sur ${count}`

  return (
    <section
      ref={regionRef}
      aria-roledescription="carrousel"
      aria-label={`Photos et vidéos — ${title}`}
      className="flex flex-col gap-3"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false)
      }}
      onKeyDown={(event) => {
        // Les flèches d'une vidéo servent à avancer dans la vidéo.
        if (count < 2 || (event.target as HTMLElement).tagName === 'VIDEO') return
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault()
          takeOver()
          goTo(current + (event.key === 'ArrowRight' ? 1 : -1))
        }
      }}
    >
      <div className="relative overflow-hidden rounded-3xl bg-muted">
        <div
          ref={trackRef}
          id={regionId}
          onPointerDown={takeOver}
          onWheel={(event) => {
            if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) takeOver()
          }}
          className="flex aspect-[4/3] snap-x snap-mandatory overflow-x-auto overscroll-x-contain scroll-smooth [scrollbar-width:none] motion-reduce:scroll-auto sm:aspect-[16/9] [&::-webkit-scrollbar]:hidden"
        >
          {items.map((media, index) => (
            <div
              key={media.id}
              role="group"
              aria-roledescription="diapositive"
              aria-label={label(index)}
              aria-hidden={index !== current}
              className="relative h-full w-full shrink-0 snap-center snap-always"
            >
              {media.kind === 'video' ? (
                <video
                  src={media.src}
                  controls
                  playsInline
                  preload="metadata"
                  aria-label={media.alt}
                  tabIndex={index === current ? 0 : -1}
                  onPlay={() => {
                    setVideoPlaying(true)
                    takeOver()
                  }}
                  onPause={() => setVideoPlaying(false)}
                  onEnded={() => setVideoPlaying(false)}
                  className="h-full w-full bg-black object-contain"
                />
              ) : (
                <Image
                  src={media.src}
                  alt={media.alt}
                  fill
                  sizes="(max-width: 896px) 100vw, 896px"
                  loading={index === 0 ? 'eager' : 'lazy'}
                  fetchPriority={index === 0 ? 'high' : 'auto'}
                  className="object-cover"
                />
              )}
            </div>
          ))}
        </div>

        {count > 1 && (
          <>
            <button
              type="button"
              aria-controls={regionId}
              aria-label="Photo précédente"
              onClick={() => {
                takeOver()
                goTo(current - 1)
              }}
              className="absolute left-3 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-primary shadow-md transition-colors duration-150 ease-out hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <ChevronLeftIcon size={22} />
            </button>
            <button
              type="button"
              aria-controls={regionId}
              aria-label="Photo suivante"
              onClick={() => {
                takeOver()
                goTo(current + 1)
              }}
              className="absolute right-3 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-primary shadow-md transition-colors duration-150 ease-out hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <ChevronRightIcon size={22} />
            </button>

            <div className="pointer-events-none absolute inset-x-3 bottom-3 flex items-end justify-between gap-2">
              {motionAllowed ? (
                <button
                  type="button"
                  onClick={() => setStopped((value) => !value)}
                  aria-label={rotating ? 'Arrêter le défilement' : 'Reprendre le défilement'}
                  className="pointer-events-auto inline-flex h-11 items-center gap-2 rounded-full bg-white/90 px-4 text-sm font-medium text-primary shadow-md transition-colors duration-150 ease-out hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  {rotating ? <PauseIcon size={16} /> : <PlayIcon size={16} />}
                  <span aria-hidden="true">{rotating ? 'Pause' : 'Défiler'}</span>
                </button>
              ) : (
                <span />
              )}
              <span
                aria-hidden="true"
                className="rounded-full bg-primary/85 px-3 py-1 text-sm font-medium tabular-nums text-white"
              >
                {current + 1} / {count}
              </span>
            </div>
          </>
        )}
      </div>

      {count > 1 && (
        <ul aria-label="Choisir une photo ou une vidéo" className="flex gap-2 overflow-x-auto pb-1">
          {items.map((media, index) => (
            <li key={media.id} className="shrink-0">
              <button
                type="button"
                aria-controls={regionId}
                aria-current={index === current ? 'true' : undefined}
                aria-label={`Afficher ${label(index).toLowerCase()} : ${media.alt}`}
                onClick={() => {
                  takeOver()
                  goTo(index)
                }}
                className={`relative block h-14 w-20 overflow-hidden rounded-lg bg-muted transition-[opacity,box-shadow] duration-150 ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                  index === current ? 'opacity-100 ring-2 ring-accent' : 'opacity-60 hover:opacity-100'
                }`}
              >
                {media.kind === 'video' ? (
                  <>
                    <video
                      src={`${media.src}#t=0.1`}
                      preload="metadata"
                      muted
                      playsInline
                      tabIndex={-1}
                      aria-hidden="true"
                      className="h-full w-full object-cover"
                    />
                    <span className="absolute inset-0 flex items-center justify-center bg-primary/30 text-white">
                      <PlayIcon size={18} />
                    </span>
                  </>
                ) : (
                  <Image src={media.src} alt="" fill sizes="80px" className="object-cover" />
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Lu quand le visiteur change lui-même de photo, pas pendant le défilement automatique. */}
      <p className="sr-only" aria-live={paused ? 'polite' : 'off'}>
        {label(current)} : {item.alt}
      </p>
    </section>
  )
}
