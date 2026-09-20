'use client';

import { LayoutDashboard, PanelLeftClose, PanelLeftOpen, Upload } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const LINKS = [
  { href: '/', label: 'Batches', icon: LayoutDashboard },
  { href: '/upload', label: 'New batch', icon: Upload },
];

export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    setCollapsed(localStorage.getItem('scraper-sidebar-collapsed') === 'true');
  }, []);

  function toggleCollapsed() {
    setCollapsed((current) => {
      const next = !current;
      localStorage.setItem('scraper-sidebar-collapsed', String(next));
      return next;
    });
  }

  return (
    <aside
      className={cn(
        'relative flex shrink-0 flex-col border-r bg-card/40 transition-[width] duration-200',
        collapsed ? 'w-16' : 'w-56',
      )}
    >
      <div className={cn('flex h-14 items-center gap-2 border-b px-3', collapsed && 'justify-center')}>
        <div className="flex size-7 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground">
          FK
        </div>
        {!collapsed && <span className="min-w-0 flex-1 text-sm font-semibold">Scraper</span>}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn(
                'size-8 text-muted-foreground',
                collapsed && 'absolute left-12 top-3 border bg-background shadow-sm',
              )}
              onClick={toggleCollapsed}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">{collapsed ? 'Expand sidebar' : 'Collapse sidebar'}</TooltipContent>
        </Tooltip>
      </div>

      <nav className="flex flex-col gap-1 p-2">
        {LINKS.map(({ href, label, icon: Icon }) => {
          const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
          const link = (
            <Link
              href={href}
              className={cn(
                'flex h-10 items-center rounded-md text-sm transition-colors',
                collapsed ? 'justify-center px-0' : 'gap-2.5 px-3',
                active
                  ? 'bg-secondary font-medium text-secondary-foreground'
                  : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground',
              )}
              aria-label={collapsed ? label : undefined}
            >
              <Icon className="size-4" aria-hidden />
              {!collapsed && <span>{label}</span>}
            </Link>
          );

          if (!collapsed) return <div key={href}>{link}</div>;

          return (
            <Tooltip key={href}>
              <TooltipTrigger asChild>{link}</TooltipTrigger>
              <TooltipContent side="right">{label}</TooltipContent>
            </Tooltip>
          );
        })}
      </nav>

      {!collapsed && (
        <div className="mt-auto border-t p-3">
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Runs locally. Keep this machine awake for the duration of a batch.
          </p>
        </div>
      )}
    </aside>
  );
}
