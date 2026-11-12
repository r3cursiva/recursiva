import { RobotIcon } from "@phosphor-icons/react"
import { Fragment, useState, type ComponentProps, type ReactNode } from "react"
import type { AvatarTone } from "@rsva/display/avatar"
import { creatureOfName, creatureShape, decodeCreature, type Creature } from "../lib/creature.ts"
import { cn } from "../lib/utils.ts"

// A person without a picture is a creature (lib/creature.ts, PLNR-366) on one of eight tones: the one they made, or
// the one their name gives. The body is the tone mixed with ink, lighter on a dark theme, so it follows every theme.
const TONES: Record<AvatarTone, string> = {
  sand: "[--avatar-tone:var(--color-avatar-sand)]",
  sage: "[--avatar-tone:var(--color-avatar-sage)]",
  mauve: "[--avatar-tone:var(--color-avatar-mauve)]",
  slate: "[--avatar-tone:var(--color-avatar-slate)]",
  clay: "[--avatar-tone:var(--color-avatar-clay)]",
  moss: "[--avatar-tone:var(--color-avatar-moss)]",
  teal: "[--avatar-tone:var(--color-avatar-teal)]",
  iris: "[--avatar-tone:var(--color-avatar-iris)]",
}
const BODY = "[--avatar-body:color-mix(in_oklab,var(--avatar-tone),var(--color-ink)_58%)] dark:[--avatar-body:color-mix(in_oklab,var(--avatar-tone),var(--color-ink)_40%)]"
/** The eyes stay white and black on every theme. */
const EYE = "#fbfaf7"
const PUPIL = "#18181b"

/** Who an avatar draws: the name, their picture's address when they have one, and their creature when they made one. */
interface Face {
  name: string
  src?: string | null | undefined
  avatar?: string | null | undefined
}

/** The creature a face draws: the one they made, or their name's. */
const creatureOf = ({ name, avatar }: Face): Creature => (avatar && decodeCreature(avatar)) || creatureOfName(name)

/** A creature in a 100 × 100 box, filling its parent. Inline, as the size of an icon a row or chip sets for its svgs
 * (`[&_svg]:size-3`) must not shrink it. */
function CreatureArt({ creature }: { creature: Creature }) {
  const { body, eyes, mouth } = creatureShape(creature)
  return (
    <svg viewBox="0 0 100 100" aria-hidden className="absolute inset-0" style={{ width: "100%", height: "100%" }}>
      <path d={body} fill="var(--avatar-body)" />
      {eyes.map((e, i) => (
        <Fragment key={i}>
          <circle cx={e.x} cy={e.y} r={e.r} fill={EYE} />
          <circle cx={e.px} cy={e.py} r={e.pr} fill={PUPIL} />
        </Fragment>
      ))}
      <path d={mouth.d} fill="none" stroke={PUPIL} strokeWidth={mouth.width} strokeLinecap="round" />
    </svg>
  )
}

/** The round ground a creature stands on, sized by the caller. */
function CreatureAvatar({ creature, className, children, ...props }: { creature: Creature } & ComponentProps<"span">) {
  return (
    <span data-slot="avatar" className={cn("relative block size-5 shrink-0 overflow-hidden rounded-full bg-(--avatar-tone)", TONES[creature.tone], BODY, className)} {...props}>
      <CreatureArt creature={creature} />
      {children}
    </span>
  )
}

/**
 * A person: their picture, or their creature. The creature stays under the picture: it shows until the picture loads and
 * again if it fails, and the picture's own background (the tone) covers it once it is there, transparent parts too.
 */
function UserAvatar({ className, ...face }: Face & { className?: string }) {
  const [failed, setFailed] = useState<string | null>(null)
  const picture = face.src && face.src !== failed ? face.src : null
  return (
    <CreatureAvatar creature={creatureOf(face)} role="img" aria-label={face.name} title={face.name} className={className}>
      {picture && <img src={picture} alt="" draggable={false} decoding="async" onError={() => setFailed(picture)} className="absolute inset-0 size-full bg-(--avatar-tone) object-cover" />}
    </CreatureAvatar>
  )
}

/** An agent: a square with a robot. Sized by the caller, as UserAvatar. */
function AgentAvatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      data-slot="avatar"
      role="img"
      aria-label={name}
      title={name}
      className={cn("grid size-5 shrink-0 place-items-center rounded-[5px] border border-rule bg-sidebar text-ink-2", className)}
    >
      <RobotIcon />
    </span>
  )
}

/** Nobody assigned: a dashed ring. */
function NoAvatar({ className }: { className?: string }) {
  return <span data-slot="avatar" aria-hidden className={cn("size-5 shrink-0 rounded-full border-[1.5px] border-dashed border-faint", className)} />
}

/** Up to `max` overlapping avatars, then "+N". A face with a `mark` draws that instead: an agent's square, a bot's logo. */
function UserAvatarStack({ people, max = 3, className }: { people: readonly (Face & { mark?: ReactNode })[]; max?: number; className?: string }) {
  const shown = people.slice(0, max)
  return (
    <span className={cn("flex -space-x-1.5 *:ring-2 *:ring-background", className)}>
      {shown.map((p, i) => (p.mark ? <Fragment key={i}>{p.mark}</Fragment> : <UserAvatar key={i} {...p} />))}
      {people.length > max && (
        <span className="relative grid size-5 place-items-center rounded-full bg-row-selected font-mono text-[9px] text-ink-3">
          +{people.length - max}
        </span>
      )}
    </span>
  )
}

export { AgentAvatar, CreatureAvatar, NoAvatar, UserAvatar, UserAvatarStack, type Face }
