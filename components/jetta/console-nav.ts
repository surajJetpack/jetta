/**
 * The console's navigation model — one description of what exists, shared by
 * the sidebar and the command palette so the two can never disagree about
 * where something lives or who may see it.
 *
 * Groups are jobs, not systems. "Work" is what needs a person today; the rest
 * is how Jetta is understood, taught and operated. A flat list of eight tabs
 * gave Today (the morning read) the same weight as Guide (documentation),
 * which is how a nav stops being read.
 *
 * `admin` here is a NAV decision, not a permission — see the note in
 * lib/roles.ts. A general user sees Today, Chats and the Guide, because that
 * is the shape of their day; the API routes remain the boundary and stay
 * deliberately more permissive.
 */
import {
  BarChart3,
  BookOpen,
  ClipboardCheck,
  CreditCard,
  FlaskConical,
  GraduationCap,
  LifeBuoy,
  MessageSquare,
  Monitor,
  Sunrise,
  type LucideIcon,
} from "lucide-react";

/** Which live counter, if any, rides on an item. Keys match /api/admin/attention. */
export type BadgeKey = "chats" | "billing" | "evals" | "kb-review";

export interface NavItem {
  id: string;
  href: string;
  label: string;
  icon: LucideIcon;
  /** What this page is for — the palette shows it, the sidebar doesn't. */
  hint: string;
  badge?: BadgeKey;
  adminOnly?: boolean;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV: NavGroup[] = [
  {
    label: "Work",
    items: [
      {
        id: "today",
        href: "/today",
        label: "Today",
        icon: Sunrise,
        hint: "The morning read — what arrived, what is spiking, what needs a person",
      },
      {
        id: "chats",
        href: "/chats",
        label: "Chats",
        icon: MessageSquare,
        hint: "Live conversations Jetta answers unsupervised",
        badge: "chats",
      },
    ],
  },
  {
    label: "Understand",
    items: [
      {
        id: "testing",
        href: "/testing",
        label: "Test Jetta",
        icon: FlaskConical,
        hint: "The manual playbook — play the customer, learn how she works",
      },
      {
        id: "insights",
        href: "/analytics",
        label: "Insights",
        icon: BarChart3,
        hint: "Volume, cost, quality and the event log",
        adminOnly: true,
      },
      {
        id: "evals",
        href: "/evals",
        label: "Evals",
        icon: GraduationCap,
        hint: "The learning loop — approve what changes how Jetta writes",
        badge: "evals",
        adminOnly: true,
      },
    ],
  },
  {
    label: "Knowledge",
    items: [
      {
        id: "kb",
        href: "/kb",
        label: "Articles",
        icon: BookOpen,
        hint: "Jetta's memory for product facts",
        adminOnly: true,
      },
      {
        id: "kb-review",
        href: "/kb/review",
        label: "Review",
        icon: ClipboardCheck,
        hint: "Draft articles waiting to be published",
        badge: "kb-review",
        adminOnly: true,
      },
    ],
  },
  {
    label: "Operate",
    items: [
      {
        id: "system",
        href: "/system",
        label: "System",
        icon: Monitor,
        hint: "What Jetta can change, and to whom",
        adminOnly: true,
      },
      {
        id: "billing",
        href: "/billing",
        label: "Billing",
        icon: CreditCard,
        hint: "Trial and discount approvals waiting on a person",
        badge: "billing",
        adminOnly: true,
      },
    ],
  },
];

/** Pinned to the sidebar footer: reference, not work. */
export const GUIDE_ITEM: NavItem = {
  id: "guide",
  href: "/guide",
  label: "Guide",
  icon: LifeBuoy,
  hint: "How Jetta works and what needs you",
};

/** The groups this reader should see, with empty groups dropped. */
export function navFor(isAdmin: boolean): NavGroup[] {
  if (isAdmin) return NAV;
  return NAV.map((g) => ({ ...g, items: g.items.filter((i) => !i.adminOnly) })).filter(
    (g) => g.items.length > 0,
  );
}

/** Flat list including the Guide — what the command palette offers. */
export function navItemsFor(isAdmin: boolean): NavItem[] {
  return [...navFor(isAdmin).flatMap((g) => g.items), GUIDE_ITEM];
}

/**
 * Which nav item owns a pathname. Longest match wins so /kb/review does not
 * light up /kb, and /chats/settings still reads as Chats.
 */
export function activeId(pathname: string, isAdmin: boolean): string | null {
  let best: NavItem | null = null;
  for (const item of navItemsFor(isAdmin)) {
    if (pathname === item.href || pathname.startsWith(`${item.href}/`)) {
      if (!best || item.href.length > best.href.length) best = item;
    }
  }
  return best?.id ?? null;
}
