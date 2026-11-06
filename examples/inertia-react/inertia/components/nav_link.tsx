import { urlFor } from '~/client'
import { usePage } from '@inertiajs/react'
import { type LucideIcon } from 'lucide-react'
import { type ReactNode } from 'react'
import { Link } from '@adonisjs/inertia/react'

export type NavRoute = Parameters<typeof urlFor>[0]

export type NavItem = {
  label: string
  route: NavRoute
  icon?: LucideIcon
  /** A path whose pages also count as this link's, when the route is one page of a section. */
  section?: string
}

/**
 * A link that marks itself with `aria-current="page"` when the current URL
 * matches its route. By default nested URLs count as a match, so a
 * "Settings" link stays active on "/settings/security". Pass `exact` to
 * only match the route itself. Pass `section` to mark the link on every page under that path.
 */
export default function NavLink({
  route,
  exact = false,
  section,
  className,
  children,
}: {
  route: NavRoute
  exact?: boolean
  section?: string
  className?: string
  children: ReactNode
}) {
  const { url } = usePage()
  const href = urlFor(route)
  const path = url.split('?')[0]
  const base = section ?? href
  const isActive = exact ? path === href : path === base || path.startsWith(`${base}/`)

  return (
    <Link href={href} className={className} aria-current={isActive ? 'page' : undefined}>
      {children}
    </Link>
  )
}
